/* kinmap.js — the part that makes a feature-by-feature comparison work.

   THE PROBLEM IT SOLVES. Comparing a child's nose with an adult's nose is not comparing like with
   like: everything about an adult face is older. The obvious fix — work out the average
   "growing up" direction and subtract it — was tried and gains nothing, because every candidate is
   an adult being compared with the same child, so a shift that lands on all of them equally cancels
   in the ranking (tools/README-calibration.md).

   WHAT DOES WORK is a map rather than a shift: a small linear map from adult space into child space,
   fitted per feature on 836 real parent/child pairs. A map can move different faces differently,
   which is the part a single direction cannot do, and it is the tractable core of the idea of
   "generate the baby first, then compare" — without a generator, so without a generator's
   inventions being mistaken for family resemblance.

   MEASURED, on KinFaceW-I — a different dataset, different families, and crucially parent and child
   photographed on different days, so no shared lighting to exploit:

     nose    0.772 -> 0.798      mouth   0.701 -> 0.742      eyes   0.773 -> 0.795
     whole face                  0.839 -> 0.816   (the map HURTS the face as a whole)
     the app's headline score    0.848 -> 0.878
     picking the real parent out of a lineup of two   85.9% -> 88.7%

   That the whole face gets worse while every feature gets better is the finding, and it is why this
   file maps regions and leaves rxEmbed's full-face vector alone: the full-face embedding is what
   recognises a PERSON, and mapping it damages exactly that.

   WHAT IS IN THE FILE. For each of three windows on the aligned face — eyes, nose, mouth — a mean
   vector, 64 principal directions of that window's embedding space, and a 64x64 map. 438 KB, fitted
   on KinFaceW-II only, so the KinFaceW-I numbers above are honest statements about this exact file.

   WHAT IT IS NOT. It is fitted on about a thousand families from two academic datasets of limited
   diversity. Like the recognition model underneath it, it is better on average, and there is no
   honest way for this app to tell you whether it is better for you. */

var RX_REGIONS = ['eyes', 'nose', 'mouth'];

/* Windows on the ArcFace 112x112 template, where the eyes sit at y=51.6, the nose tip at y=71.7 and
   the mouth corners at y=92.3. Outside the window the crop is filled mid-grey, which is zero after
   the model's own normalisation — the least disruptive thing to show a network trained on whole
   faces. Any mask is out of distribution for it; the maps are fitted through the same masks, so what
   the network makes of the grey is part of what was measured. */
var RX_REGION_WINDOWS = {
  eyes:  [14, 32, 98, 64],
  nose:  [30, 56, 82, 86],
  mouth: [22, 78, 90, 108]
};

function rxKinmapPath(){ return new URL('models/kinmap.bin', document.baseURI).href; }

var rxKinmapState = { maps: null, loading: null };

/* Layout: 'RXKM', version, D, P, then per region in RX_REGIONS order — mu (D), P components of D,
   then the P x P map, all little-endian float32. */
function rxParseKinmap(buf){
  var dv = new DataView(buf);
  if(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'RXKM') return null;
  if(dv.getUint32(4, true) !== 1) return null;
  var D = dv.getUint32(8, true), P = dv.getUint32(12, true);
  var f = new Float32Array(buf, 16);
  var at = 0, maps = { D: D, P: P };
  RX_REGIONS.forEach(function(name){
    var mu = f.subarray(at, at + D); at += D;
    var comps = []; var i;
    for(i = 0; i < P; i++){ comps.push(f.subarray(at, at + D)); at += D; }
    var W = [];
    for(i = 0; i < P; i++){ W.push(f.subarray(at, at + P)); at += P; }
    maps[name] = { mu: mu, comps: comps, W: W };
  });
  if(at * 4 + 16 !== buf.byteLength) return null;
  return maps;
}

function rxLoadKinmap(onProgress){
  if(rxKinmapState.maps) return Promise.resolve(rxKinmapState.maps);
  if(rxKinmapState.loading) return rxKinmapState.loading;
  var note = onProgress || function(){};
  rxKinmapState.loading = (async function(){
    note(0, 'Fetching the feature maps (under 1 MB, once)');
    var bytes = await rxFetchBytes(rxKinmapPath(), function(got, total){ note(got / total, ''); });
    var maps = rxParseKinmap(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
    if(!maps) throw new Error('The feature maps are not readable.');
    rxKinmapState.maps = maps;
    note(1, '');
    return maps;
  })();
  rxKinmapState.loading.catch(function(){ rxKinmapState.loading = null; });
  return rxKinmapState.loading;
}

/* An embedding, centred and projected onto the region's principal directions. */
function rxProject(map, vec){
  var P = map.comps.length, D = map.mu.length, out = new Float64Array(P), i, j, s, c;
  for(i = 0; i < P; i++){
    s = 0; c = map.comps[i];
    for(j = 0; j < D; j++) s += (vec[j] - map.mu[j]) * c[j];
    out[i] = s;
  }
  return out;
}
function rxUnit(v){
  var n = 0, i, out = new Float64Array(v.length);
  for(i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for(i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
/* The adult, moved into child space. */
function rxMapAdult(map, z){
  var P = z.length, out = new Float64Array(P), i, j, zi, row;
  for(i = 0; i < P; i++){
    zi = z[i];
    if(!zi) continue;
    row = map.W[i];
    for(j = 0; j < P; j++) out[j] += zi * row[j];
  }
  return rxUnit(out);
}

/* One region of an adult against the same region of the child, as a cosine. The direction matters:
   the map goes adult -> child, so swapping the arguments is not the same comparison. */
function rxRegionCosine(maps, name, adultVec, childVec){
  if(!maps || !maps[name] || !adultVec || !childVec) return null;
  var map = maps[name];
  if(adultVec.length !== map.mu.length || childVec.length !== map.mu.length) return null;
  var a = rxMapAdult(map, rxProject(map, adultVec));
  var c = rxUnit(rxProject(map, childVec));
  var s = 0;
  for(var i = 0; i < a.length; i++) s += a[i] * c[i];
  return s;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_REGIONS: RX_REGIONS, RX_REGION_WINDOWS: RX_REGION_WINDOWS,
    rxParseKinmap: rxParseKinmap, rxProject: rxProject, rxMapAdult: rxMapAdult,
    rxRegionCosine: rxRegionCosine, rxUnit: rxUnit };
}
