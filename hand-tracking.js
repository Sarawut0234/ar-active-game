/* Focus one active hand without following MediaPipe's changing result-array order.
   A lost primary is reacquired automatically; this is not person identification. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ARTracking = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

  class OneEuroFilter {
    constructor(minCutoff = 1.8, beta = 7) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.time = null;
    }
    filter(value, now) {
      if (this.time == null) {
        this.time = now; this.raw = value; this.value = value; this.speed = 0;
        return value;
      }
      const dt = clamp((now - this.time) / 1000, 1 / 240, .15);
      const derivative = (value - this.raw) / dt;
      this.speed += alpha(1, dt) * (derivative - this.speed);
      this.value += alpha(this.minCutoff + this.beta * Math.abs(this.speed), dt) * (value - this.value);
      this.raw = value; this.time = now;
      return this.value;
    }
  }

  class HandTracker {
    constructor(options = {}) {
      this.options = Object.assign({
        visibleGrace:250, cancelAfter:650,
        closeRatio:.32, openRatio:.50, closeDwell:80, openDwell:100,
        enrollmentDwell:500
      }, options);
      this.reset();
    }
    reset() { this.tracks = []; this.excluded = []; this.locked = false; this.primaryID = null; this.nextID = 1; }
    disarm() {
      this.tracks.forEach(t => {
        t.armed = false; t.pinched = false; t.pending = null; t.openSince = null;
      });
    }
    canLock(now) {
      return this.tracks.length === 2 && this.tracks.every(t =>
        now - t.lastSeen <= this.options.visibleGrace &&
        now - t.firstSeen >= this.options.enrollmentDwell);
    }
    lock(now, preferredID = null) {
      if (!this.canLock(now)) return false;
      const primary = this.tracks.find(t => t.id === preferredID) || this.tracks.find(t => t.pinched) || this.tracks[0];
      this.locked = true;
      this.tracks = [primary];
      this.primaryID = primary.id;
      this.excluded = [];
      this.disarm(); // A pinch used for calibration must not pick up a card.
      return true;
    }
    createTrack(obs, now, events) {
      const track = {id:'hand-'+this.nextID++,firstSeen:now,lastSeen:now,palm:obs.palm,scale:obs.scale,shape:obs.shape,
        label:obs.label,confidence:obs.confidence,velocity:{x:0,y:0},pinched:false,armed:false,pending:null,
        openSince:null,cancelled:false,fx:new OneEuroFilter(),fy:new OneEuroFilter(),landmarks:null};
      this.tracks.push(track);
      this.accept(track,obs,now,events);
      return track;
    }
    acquirePrimary(observations, now, events) {
      if (!observations.length) return;
      // Prefer an intentional pinch, then the clearest/largest hand, not array position.
      const ranked = observations.slice().sort((a,b) => {
        const pinchingA = a.pinch <= this.options.closeRatio ? 1 : 0;
        const pinchingB = b.pinch <= this.options.closeRatio ? 1 : 0;
        return pinchingB-pinchingA || b.scale-a.scale ||
          Math.hypot(a.palm.x-.5,a.palm.y-.5)-Math.hypot(b.palm.x-.5,b.palm.y-.5) || a.palm.x-b.palm.x;
      });
      const primary = this.createTrack(ranked[0],now,events);
      this.primaryID = primary.id;
      events.push({type:'focus',id:primary.id});
      // The new hand starts disarmed: detecting a closed hand must not grab by itself.
    }
    observation(landmarks, handedness, aspect) {
      if (!Array.isArray(landmarks) || landmarks.length !== 21 || landmarks.some(p =>
        !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -.3 || p.x > 1.3 || p.y < -.3 || p.y > 1.3)) return null;
      const distance = (a,b) => Math.hypot((a.x-b.x)*aspect, a.y-b.y);
      const palm = [0,5,9,13,17].reduce((p,i) => ({x:p.x+landmarks[i].x/5,y:p.y+landmarks[i].y/5}),{x:0,y:0});
      const scale = distance(landmarks[5],landmarks[17]);
      if (scale < .025 || scale > .8) return null;
      const h = handedness && (handedness.classification ? handedness.classification[0] : handedness);
      const label = h && (h.label === 'Left' || h.label === 'Right') ? h.label : null;
      return {landmarks,palm,scale,label,confidence:h && Number.isFinite(h.score) ? h.score : 0,
        pinch:distance(landmarks[4],landmarks[8])/scale,
        shape:[5,9,13,17].map(i => distance(landmarks[0],landmarks[i])/scale)};
    }
    cost(track, obs, now, aspect) {
      if (track.confidence > .8 && obs.confidence > .8 && track.label && obs.label && track.label !== obs.label) return Infinity;
      const age = Math.max(0,(now-track.lastSeen)/1000);
      const ratio = obs.scale/track.scale;
      if (ratio < .55 || ratio > 1.85) return Infinity;
      const distance = Math.hypot((obs.palm.x-track.palm.x)*aspect,obs.palm.y-track.palm.y);
      if (distance > .10 + Math.min(.03,age*.3)) return Infinity;
      const predictTime = Math.min(age,.1);
      const px = track.palm.x+track.velocity.x*predictTime;
      const py = track.palm.y+track.velocity.y*predictTime;
      const prediction = Math.hypot((obs.palm.x-px)*aspect,obs.palm.y-py);
      const shape = obs.shape.reduce((sum,v,i) => sum+Math.abs(v-track.shape[i]),0)/4;
      return prediction + Math.abs(Math.log(ratio))*.035 + shape*.025;
    }
    match(observations, now, aspect, blocked) {
      const costs = this.tracks.map(t => observations.map((o,i) => blocked.has(i) ? Infinity : this.cost(t,o,now,aspect)));
      // When another similar hand makes ownership ambiguous, freeze rather than switch.
      costs.forEach(row => {
        const sorted = row.filter(Number.isFinite).sort((a,b) => a-b);
        if (sorted.length > 1 && sorted[1]-sorted[0] < .018) row.fill(Infinity);
      });
      let best = {cost:Infinity,assignment:[]};
      const visit = (i,used,assignment,cost) => {
        if (i === costs.length) {
          if (cost < best.cost) best = {cost,assignment:assignment.slice()};
          return;
        }
        assignment.push(-1); visit(i+1,used,assignment,cost+1); assignment.pop();
        observations.forEach((_,j) => {
          if (used.has(j) || !Number.isFinite(costs[i][j])) return;
          used.add(j); assignment.push(j);
          visit(i+1,used,assignment,cost+costs[i][j]);
          assignment.pop(); used.delete(j);
        });
      };
      visit(0,new Set(),[],0);
      return best.assignment;
    }
    gesture(track, ratio, now, events) {
      const opt = this.options;
      if (ratio >= opt.openRatio) {
        if (track.openSince == null) track.openSince = now;
        if (now-track.openSince >= opt.openDwell) track.armed = true;
      } else track.openSince = null;
      const change = track.pinched ? ratio >= opt.openRatio : ratio <= opt.closeRatio;
      if (!change) { track.pending = null; return; }
      const next = !track.pinched;
      if (!track.pending || track.pending.next !== next) track.pending = {next,since:now};
      if (now-track.pending.since < (next ? opt.closeDwell : opt.openDwell)) return;
      track.pinched = next; track.pending = null;
      if (next) {
        if (this.locked && track.armed) events.push({type:'pinchstart',id:track.id});
        track.armed = false;
      } else if (this.locked) events.push({type:'pinchend',id:track.id});
    }
    update(results, now, aspect = 16/9) {
      const events = [];
      results=results || {};
      const landmarks=Array.isArray(results.multiHandLandmarks) ? results.multiHandLandmarks : [];
      const handedness=Array.isArray(results.multiHandedness) ? results.multiHandedness : [];
      const observations = landmarks.slice(0,4).map((lm,i) =>
        this.observation(lm,handedness[i],aspect)).filter(Boolean);
      if (this.locked && this.tracks.length && now-this.tracks[0].lastSeen >= this.options.cancelAfter) {
        // Cancel, never drop, before assigning a different hand or resetting its filters.
        const previous=this.tracks[0];
        if (!previous.cancelled) events.push({type:'cancel',id:previous.id});
        previous.cancelled=true; previous.armed=false; previous.pinched=false;
        const nearby=observations.map(o=>this.cost(previous,o,now,aspect)).filter(Number.isFinite).sort((a,b)=>a-b);
        const ambiguous=nearby.length>1 && nearby[1]-nearby[0]<.018;
        // Overlapping lookalike hands are uncertainty, not permission to hand focus to a bystander.
        if (!ambiguous) { this.tracks = []; this.primaryID = null; this.excluded = []; }
      }
      if (this.locked && !this.tracks.length) {
        this.acquirePrimary(observations,now,events);
        return {tracks:this.tracks,events,locked:this.locked,primaryID:this.primaryID};
      }
      if (!this.locked) this.tracks = this.tracks.filter(t => now-t.lastSeen < 1200);
      this.excluded=this.excluded.filter(t => now-t.lastSeen<2500);
      const blocked=new Set();
      if (this.locked) {
        const edges=[];
        this.excluded.forEach((t,j) => observations.forEach((o,i) => {
          const distance=Math.hypot((o.palm.x-t.palm.x)*aspect,o.palm.y-t.palm.y);
          if ((!t.label || !o.label || t.label===o.label) && o.scale/t.scale>.55 && o.scale/t.scale<1.85 && distance<.10)
            edges.push({i,j,distance});
        }));
        const assigned=new Set();
        edges.sort((a,b) => a.distance-b.distance).forEach(({i,j}) => {
          if (blocked.has(i) || assigned.has(j)) return;
          this.excluded[j].palm=observations[i].palm; this.excluded[j].lastSeen=now;
          blocked.add(i); assigned.add(j);
        });
      }
      const assignment = this.match(observations,now,aspect,blocked);
      const used = new Set();
      this.tracks.forEach((t,i) => {
        if (assignment[i] >= 0) { used.add(assignment[i]); this.accept(t,observations[assignment[i]],now,events); }
        else {
          const age = now-t.lastSeen;
          if (age > this.options.visibleGrace) { t.pending=null; t.openSince=null; }
          if (age >= this.options.cancelAfter && !t.cancelled) {
            t.cancelled=true; t.armed=false; t.pinched=false;
            events.push({type:'cancel',id:t.id});
          }
        }
      });
      if (this.locked) observations.forEach((o,i) => {
        if (used.has(i) || blocked.has(i)) return;
        // Keep spare hands ignored while the primary is still tracked (including its short loss grace).
        const primaryVisible=assignment.length===1 && assignment[0]>=0;
        if (primaryVisible || this.tracks.every(t => !Number.isFinite(this.cost(t,o,now,aspect)))) {
          this.excluded.push({palm:o.palm,scale:o.scale,label:o.label,lastSeen:now});
          if (this.excluded.length>8) this.excluded.shift();
        }
      });
      // During initial setup collect both choices. During play only the primary can control cards.
      if (!this.locked) {
        observations.map((o,i) => ({o,i})).filter(({i}) => !used.has(i)).sort((a,b) => b.o.scale-a.o.scale).forEach(({o}) => {
          if (this.tracks.length >= 2 || this.tracks.some(t =>
            Math.hypot((t.palm.x-o.palm.x)*aspect,t.palm.y-o.palm.y) < .10)) return;
          this.createTrack(o,now,events);
        });
      }
      return {tracks:this.tracks,events,locked:this.locked,primaryID:this.primaryID};
    }
    accept(track, obs, now, events) {
      const gap = now-track.lastSeen;
      if (gap > this.options.visibleGrace) {
        track.armed=false; track.pending=null; track.openSince=null;
        // Keep a short interrupted pinch held until a confirmed open gesture.
        if (track.cancelled) track.pinched=false;
      }
      const dt = clamp(gap/1000,1/120,.15);
      track.velocity.x = clamp((obs.palm.x-track.palm.x)/dt,-1.5,1.5);
      track.velocity.y = clamp((obs.palm.y-track.palm.y)/dt,-1.5,1.5);
      track.palm=obs.palm; track.scale += (obs.scale-track.scale)*.2;
      track.lastSeen=now; track.cancelled=false;
      if (!track.label && obs.confidence > .8) { track.label=obs.label; track.confidence=obs.confidence; }
      track.pointer = {x:track.fx.filter(obs.landmarks[8].x,now),y:track.fy.filter(obs.landmarks[8].y,now)};
      const blend = alpha(8,dt);
      track.landmarks = obs.landmarks.map((p,i) => {
        const old = track.landmarks && track.landmarks[i];
        return {x:old ? old.x+(p.x-old.x)*blend : p.x,y:old ? old.y+(p.y-old.y)*blend : p.y,z:Number.isFinite(p.z) ? p.z : 0};
      });
      track.landmarks[8].x=track.pointer.x; track.landmarks[8].y=track.pointer.y;
      this.gesture(track,obs.pinch,now,events);
    }
  }
  return {HandTracker,OneEuroFilter};
});
