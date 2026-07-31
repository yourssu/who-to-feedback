document.documentElement.classList.add('js');
(function(){
  var root=document.documentElement;
  var saved=localStorage.getItem('peerflow-theme');
  if(saved) root.dataset.theme=saved;
  document.addEventListener('click',function(e){
    var toggle=e.target.closest('[data-theme-toggle]');
    if(toggle){var next=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=next;localStorage.setItem('peerflow-theme',next);return}
    var opener=e.target.closest('[data-modal-open]');
    if(opener){var modal=document.getElementById(opener.dataset.modalOpen);if(modal)modal.classList.add('open');return}
    var closer=e.target.closest('[data-modal-close]');
    if(closer){closer.closest('.modal').classList.remove('open');return}
    if(e.target.classList.contains('modal'))e.target.classList.remove('open');
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('.modal.open').forEach(function(m){m.classList.remove('open')})});
  document.querySelectorAll('form[data-confirm]').forEach(function(form){form.addEventListener('submit',function(e){if(!window.confirm(form.dataset.confirm))e.preventDefault()})});
  document.querySelectorAll('[data-count]').forEach(function(el){var out=document.querySelector(el.dataset.count);var update=function(){out.textContent=el.value.length};el.addEventListener('input',update);update()});
  document.querySelectorAll('[data-toggle-target]').forEach(function(el){var update=function(){var target=document.querySelector(el.dataset.toggleTarget);if(target)target.hidden=el.value!==el.dataset.toggleValue};el.addEventListener('change',update);update()});
  document.querySelectorAll('[data-filter-select]').forEach(function(filter){filter.addEventListener('change',function(){var target=document.querySelector(filter.dataset.filterSelect);var first=null;Array.from(target.options).forEach(function(o){var show=!filter.value||o.dataset.department===filter.value;o.hidden=!show;if(show&&!first)first=o});if(first)target.value=first.value})});
  document.querySelectorAll('[data-mobile-placeholder]').forEach(function(field){var media=window.matchMedia('(max-width:900px)');var update=function(){field.placeholder=media.matches?field.dataset.mobilePlaceholder:field.dataset.desktopPlaceholder};media.addEventListener('change',update);update()});
  document.addEventListener('change',function(e){
    if(!e.target.matches('.rating-option input[type="radio"]'))return;
    var grid=e.target.closest('.score-grid');
    var value=grid&&grid.querySelector('[data-rating-value]');
    if(value)value.textContent=e.target.value+' / 5';
  });
  var wizard=document.querySelector('[data-review-wizard]');
  if(wizard){
    var overview=wizard.querySelector('.wizard-overview'),steps=Array.from(wizard.querySelectorAll('.wizard-step')),index=-1;
    var show=function(i){index=i;overview.classList.toggle('hidden',i>=0);steps.forEach(function(s,n){s.classList.toggle('active',n===i)});var now=i<0?0:i+1;wizard.querySelectorAll('[data-current-step]').forEach(function(x){x.textContent=now});var bar=wizard.querySelector('[data-wizard-progress]');if(bar)bar.style.width=(steps.length?Math.max(0,now/steps.length*100):0)+'%';window.scrollTo({top:0,behavior:'smooth'})};
    var valid=function(step){var required=Array.from(step.querySelectorAll('[required]'));for(var i=0;i<required.length;i++){var field=required[i];if((field.type==='radio'||field.type==='checkbox')&&!step.querySelector('[name="'+field.name+'"]:checked')){field.focus();return false}if(!field.value.trim()){field.focus();field.reportValidity();return false}}return true};
    wizard.addEventListener('click',function(e){var start=e.target.closest('[data-wizard-start]'),next=e.target.closest('[data-wizard-next]'),prev=e.target.closest('[data-wizard-prev]');if(start){show(0)}if(next&&valid(steps[index])){show(index+1)}if(prev){show(index-1)}});show(-1);
  }
})();
