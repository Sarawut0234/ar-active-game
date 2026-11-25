// Synthetic landmarks for deterministic tracking tests; not recorded camera data.
function hand(x=.25,y=.4,ratio=.9,label='Left',size=1) {
  const points=[
    [0,.12],[-.05,.10],[-.08,.06],[-.1,.01],[-.1,-.06],
    [-.06,0],[-.06,-.05],[-.06,-.10],[-.06,-.16],
    [-.02,-.015],[-.02,-.07],[-.02,-.13],[-.02,-.19],
    [.02,0],[.02,-.05],[.02,-.10],[.02,-.15],
    [.06,.02],[.06,-.02],[.06,-.06],[.06,-.10]
  ].map(([px,py])=>({x:x+px*size,y:y+py*size,z:0}));
  const scale=Math.hypot((points[5].x-points[17].x)*16/9,points[5].y-points[17].y);
  points[4]={x:points[8].x+ratio*scale/(16/9),y:points[8].y,z:0};
  return {points,label};
}
function results(...hands) {
  return {multiHandLandmarks:hands.map(h=>h.points),multiHandedness:hands.map(h=>({label:h.label,score:.99}))};
}
module.exports={hand,results};
