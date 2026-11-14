/* Shared completion sequence for the real progress bar and its preview.
   Visual state only: this module never changes learning records. */
(() => {
  const states=new WeakMap();
  window.updateGooseEnding=function(goose,{complete=false,examEnded=false}={}){
    const reason=complete?'complete':examEnded?'exam-ended':'';
    let state=states.get(goose);
    if(!state){
      state={reason:'',timers:[]};states.set(goose,state);
      const finish=document.createElement('span');finish.className='finish-scene';finish.setAttribute('aria-hidden','true');
      finish.innerHTML='<img class="relief-frame" src="assets/goose.png" alt=""><img class="cheer-frame" src="assets/goose-cheer.png" alt=""><span class="goose-bubble">呼～</span><i class="breath-puff"></i><span class="goose-confetti"><i></i><i></i><i></i><i></i><i></i><i></i></span>';
      goose.append(finish);state.bubble=finish.querySelector('.goose-bubble');
    }
    if(state.reason===reason)return;
    state.timers.forEach(clearTimeout);state.timers=[];state.reason=reason;
    if(!reason){delete goose.dataset.ending;return;}
    goose.dataset.ending='relief';state.bubble.textContent='呼～辛苦了';
    goose.setAttribute('aria-label',complete?'全部完成！溫書鵝先鬆一口氣，再開心歡呼。':'考試結束了！溫書鵝先鬆一口氣，再開心歡呼。');
    state.timers.push(setTimeout(()=>{
      goose.dataset.ending='cheer';state.bubble.textContent=complete?'耶！全部完成！':'耶！考完了！';
    },1100));
    state.timers.push(setTimeout(()=>{goose.dataset.ending='settled';},3500));
  };
})();
