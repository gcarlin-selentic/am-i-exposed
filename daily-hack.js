// Filtros del Daily Hack. Generado por tools/build-daily-hack.py.
(function(){
 var caja=document.getElementById('filtros');
 if(!caja)return;
 var q=document.getElementById('fQ'),c=document.getElementById('fCountry'),
     s=document.getElementById('fSector'),g=document.getElementById('fGroup'),
     e=document.getElementById('fState'),r=document.getElementById('fReset'),
     nada=document.getElementById('sinResultados');
 var LIM=parseInt(caja.dataset.lim,10)||40;
 var UNO=caja.dataset.one||'',VARIOS=caja.dataset.many||'',
     MAS=caja.dataset.more||'',MENOS=caja.dataset.less||'';
 var campos=[q,c,s,g].concat(e?[e]:[]);
 function texto(tr){
  if(!tr._t)tr._t=(tr.textContent||'').toLowerCase();
  return tr._t;
 }
 function paint(){
  var Q=q.value.trim().toLowerCase(),C=c.value,S=s.value,G=g.value,E=e?e.value:'';
  var open=Q||C||S||G||E;
  var total=0;
  document.querySelectorAll('section.region').forEach(function(sec){
   var n=0;
   sec.querySelectorAll('tr[data-r]').forEach(function(tr){
    var ok=(!C||tr.dataset.c===C)&&(!S||tr.dataset.s===S)&&(!G||tr.dataset.g===G)
           &&(!E||tr.dataset.e===E)&&(!Q||texto(tr).indexOf(Q)>=0);
    if(ok)n++;
    tr.hidden=!ok||(!open&&n>LIM&&!sec.classList.contains('all'));
   });
   total+=n;
   sec.querySelector('.c').textContent=n+' '+(n===1?UNO:VARIOS);
   var btn=sec.querySelector('.more button');
   if(btn)btn.hidden=open||n<=LIM;
   var em=sec.querySelector('.empty');
   if(em)em.hidden=n>0;
   sec.hidden=open&&n===0;
  });
  // Con todas las secciones escondidas no quedaba nada en pantalla y parecia
  // que la pagina se habia roto. Un pais sin casos esta semana es una
  // respuesta, y hay que darla.
  if(nada)nada.hidden=!(open&&total===0);
 }
 campos.forEach(function(el){el.addEventListener('input',paint);el.addEventListener('change',paint);});
 r.addEventListener('click',function(){q.value='';c.value='';s.value='';g.value='';if(e)e.value='';paint();});
 document.querySelectorAll('.more button').forEach(function(b){
  b.addEventListener('click',function(){
   var sec=b.closest('section.region');
   sec.classList.toggle('all');
   b.textContent=sec.classList.contains('all')?MENOS:MAS;
   paint();
  });
 });
 paint();
})();
