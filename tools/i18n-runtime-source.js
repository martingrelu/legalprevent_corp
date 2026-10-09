const normalise = value => String(value).replace(/\s+/g,' ').trim();
const keys = Object.keys(dictionary).filter(key => dictionary[key] !== key).sort((a,b)=>b.length-a.length);
const pattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + keys.map(key=>key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')(?![\\p{L}\\p{N}])','gu');
const t = value => {
  if (typeof value !== 'string') return value;
  const key = normalise(value);
  return dictionary[key] ?? value.replace(pattern,match=>dictionary[match]);
};
window.LegalPreventI18n = { t };
const translateNode = node => {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement?.closest('script,style,textarea,[contenteditable],input')) return;
    const value = t(node.data);
    if (value !== node.data) node.data = value;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    for (const attr of ['aria-label','placeholder','alt']) {
      if (node.hasAttribute(attr)) {
        const original = node.getAttribute(attr), translated = t(original);
        if (translated !== original) node.setAttribute(attr,translated);
      }
    }
  }
};
const translateTree = root => {
  translateNode(root);
  const walker = document.createTreeWalker(root,NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) translateNode(walker.currentNode);
};
const observer = new MutationObserver(records=>{
  observer.disconnect();
  for (const record of records) {
    if (record.type === 'characterData' || record.type === 'attributes') translateNode(record.target);
    else record.addedNodes.forEach(translateTree);
  }
  observe();
});
const observe = () => observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','placeholder','alt']});
observe();
document.addEventListener('DOMContentLoaded',()=>{
  translateTree(document.documentElement);
  document.documentElement.dataset.i18nReady = 'true';
});
