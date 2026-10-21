// Shared file-type table used by the popup and the grid viewer.
// "kind" decides which renderer is used.
const GG_KINDS = {
  image:   { label: 'Image',   exts: ['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif'] },
  pdf:     { label: 'PDF',     exts: ['pdf'] },
  video:   { label: 'Video',   exts: ['mp4','webm','ogv','mov','m4v','mkv','avi','wmv','flv','3gp','mpeg','mpg'] },
  audio:   { label: 'Audio',   exts: ['mp3','wav','ogg','oga','m4a','aac','flac','opus','weba','wma','amr','aiff','aif','mka'] },
  doc:     { label: 'Word',    exts: ['docx','doc'] },
  sheet:   { label: 'Sheet',   exts: ['xlsx','xls','xlsm','ods','csv','tsv'] },
  slides:  { label: 'Slides',  exts: ['pptx','ppt'] },
  notebook:{ label: 'Notebook',exts: ['ipynb'] },
  code:    { label: 'Code/Text', exts: ['txt','md','markdown','log','c','h','cpp','cc','cxx','hpp','java','py','js','mjs','ts','jsx','tsx','json','xml','html','htm','css','scss','sql','sh','bash','bat','ps1','yml','yaml','ini','toml','cfg','v','sv','vhd','vhdl','m','r','rb','go','rs','kt','kts','swift','php','cs','dart','lua','pl','asm','s','tex','bib','gradle','properties','env','gitignore'] },
  archive: { label: 'ZIP',     exts: ['zip'] },
  model3d: { label: '3D (STL/OBJ)', exts: ['stl','obj'] },
  circuit: { label: 'Logisim .circ', exts: ['circ'] },
};

// Kinds that are NOT offered in the page-scan selection (still viewable inside ZIPs or via drag-drop).
const GG_HIDDEN_IN_SELECTION = ['code'];

const GG_EXT_TO_KIND = {};
for (const [kind, def] of Object.entries(GG_KINDS)) for (const e of def.exts) GG_EXT_TO_KIND[e] = kind;

// Extensions we recognise as "a file" when scanning a page, even if we can only show info for them.
const GG_EXTRA_FILE_EXTS = ['dwg','dxf','step','stp','iges','igs','sldprt','sldasm','f3d','ipt','skp','fcstd','rar','7z','tar','gz','odt','odp','rtf','psd','ai','eps','exe','apk','mat','slx','mdl','ino','hex','bin','pcb','sch','kicad_pcb','fzz','dig','sim','jar','class','whl','epub'];

function ggKindOf(ext) {
  return GG_EXT_TO_KIND[(ext || '').toLowerCase()] || 'other';
}
function ggKindLabel(kind) {
  return (GG_KINDS[kind] && GG_KINDS[kind].label) || 'Other';
}
function ggIsKnownFileExt(ext) {
  ext = (ext || '').toLowerCase();
  return !!GG_EXT_TO_KIND[ext] || GG_EXTRA_FILE_EXTS.includes(ext);
}
