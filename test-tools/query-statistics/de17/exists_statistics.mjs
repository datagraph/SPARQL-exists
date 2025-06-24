#!/usr/bin/env node
/*
 * exists_statistics.mjs  — 2025-06-23 (vars, IRIs, **blank-nodes** anonymised)
 * ---------------------------------------------------------------------------
 * Outputs:
 *   exists_statistics.csv
 *   exists_statistics.txt
 *   exists_forms/<hash>.rq
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Parser as SparqlParser, Generator as SparqlGenerator } from "sparqljs";

const generator = new SparqlGenerator({ allPrefixes:false });
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ── helpers ─────────────────────────────────────────────────────────── */
async function* walk(dir){ for(const d of await fs.promises.readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,d.name); if(d.isDirectory()) yield*walk(p); else yield p;}}

function traverse(n,fn){ fn(n);
  if(Array.isArray(n))n.forEach(x=>traverse(x,fn));
  else if(n&&typeof n==="object")Object.values(n).forEach(v=>traverse(v,fn));}

const sha1=s=>crypto.createHash("sha1").update(s,"utf8").digest("hex");
/* enhanced clone that accepts replacer */
const clone=(o,rep)=>JSON.parse(JSON.stringify(o,rep));

/* ── anonymise vars, IRIs, BLANK NODES ──────────────────────────────── */
function anonymise(pattern){
  const vMap=new Map(), iMap=new Map(), bMap=new Map();
  let vSeq=0,iSeq=0,bSeq=0;
  const rep=(k,val)=>{
    if(val&&typeof val==="object"){
      if(val.termType==="Variable"){
        if(!vMap.has(val.value)) vMap.set(val.value,`v${vSeq++}`);
        return {...val,value:vMap.get(val.value)};
      }
      if(val.termType==="NamedNode"){
        if(!iMap.has(val.value)) iMap.set(val.value,`x${iSeq++}`);
        return {...val,value:`http://example.org/${iMap.get(val.value)}`};
      }
      if(val.termType==="BlankNode"){
        if(!bMap.has(val.value)) bMap.set(val.value,`b${bSeq++}`);
        return {...val,value:bMap.get(val.value)};
      }
    }
    return val;
  };
  return clone(pattern,rep);
}

/* ── stable + blank-node rename for JSON fallback ───────────────────── */
const stable=x=>Array.isArray(x)?x.map(stable)
  :(x&&typeof x==="object")
    ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])]))
    :x;
function renameBN(obj){
  const map=new Map();let n=0;
  const w=v=>{
    if(typeof v==="string"&&v.startsWith("_:")){
      if(!map.has(v))map.set(v,`_:b${n++}`);return map.get(v);
    }
    if(Array.isArray(v))return v.map(w);
    if(v&&typeof v==="object"){const o={};for(const k of Object.keys(v))o[k]=w(v[k]);return o;}
    return v;
  };return w(obj);
}

/* ── canonical string for EXISTS pattern ────────────────────────────── */
const parser=new SparqlParser();
function toCanonical(patternArr){
  const pat=anonymise(patternArr);
  try{
    const txt=generator.stringify({type:"query",queryType:"SELECT",variables:["*"],where:pat});
    return "EXISTS "+txt.slice(txt.indexOf("{")).trim().replace(/\n/g,"\\n");
  }catch{}
  const term=t=>{
    switch(t.termType){
      case"Variable":return`?${t.value}`;
      case"NamedNode":return`<${t.value}>`;
      case"BlankNode":return`_:${t.value}`;
      case"Literal":return`"${t.value}"`;
      default:return"?";
    }
  };
  const triples=[];
  traverse(pat,n=>{
    if(Array.isArray(n)&&n.length&&n[0].subject)
      n.forEach(tr=>triples.push(`  ${term(tr.subject)} ${term(tr.predicate)} ${term(tr.object)} .`));
  });
  if(triples.length)return"EXISTS {\\n"+triples.join("\\n")+"\\n}";
  return"EXISTS "+JSON.stringify(renameBN(stable(pat))).replace(/\n/g,"\\n");
}
function extractExists(n){
  if(n&&n.type==="operation"&&n.operator==="exists"){
    if(Array.isArray(n.args)&&n.args[0])return n.args[0];
    if(n.patterns)return n.patterns;
  }return null;
}

/* ── main ───────────────────────────────────────────────────────────── */
(async()=>{
  const root=process.argv[2];
  if(!root){console.error("usage: node exists_statistics.mjs <queryDir>");process.exit(1);}
  const abs=path.resolve(root);
  if(!fs.existsSync(abs)||!fs.statSync(abs).isDirectory()){
    console.error("Not a directory: "+abs);process.exit(1);
  }

  const forms=new Map(); let qTotal=0,eTotal=0;
  for await(const file of walk(abs)){
    let src; try{src=await fs.promises.readFile(file,"utf8");}catch{continue;}
    let ast; try{ast=parser.parse(src);qTotal++;}catch{continue;}
    traverse(ast,node=>{
      const pat=extractExists(node); if(!pat)return;
      eTotal++;
      let comp=0; const ops=new Set();
      traverse(pat,n=>{
        if(Array.isArray(n)&&n.length&&n[0].subject){comp+=Math.max(0,n.length-1);return;}
        if(n&&n.type==="operation"&&n.operator&&n.operator!=="exists"){comp++;ops.add(n.operator);}
      });
      const form=toCanonical(pat); const hash=sha1(form);
      const e=forms.get(hash)||{count:0,complexity:comp,ops,form,sample:src};
      e.count++; forms.set(hash,e);
    });
  }

  /* CSV */
  const csv=fs.createWriteStream(path.join(__dirname,"exists_statistics.csv"),"utf8");
  csv.write("hash,count,complexity,operators,form\n");
  for(const [h,{count,complexity,ops,form}] of forms)
    csv.write(`${h},${count},${complexity},${[...ops].sort().join(";")},"${form.replace(/\"/g,'""')}"\n`);
  csv.end();

  /* summary TXT */
  const avg=forms.size?[...forms.values()].reduce((s,e)=>s+e.complexity,0)/forms.size:0;
  fs.writeFileSync(path.join(__dirname,"exists_statistics.txt"),
    `Total queries processed : ${qTotal}\n`+
    `Total EXISTS occurrences: ${eTotal}\n`+
    `Distinct EXISTS forms   : ${forms.size}\n`+
    `Average complexity      : ${avg.toFixed(2)}\n`,"utf8");

  /* sample queries */
  const out=path.join(__dirname,"exists_forms"); await fs.promises.mkdir(out,{recursive:true});
  for(const [h,{sample}] of forms) await fs.promises.writeFile(path.join(out,`${h}.rq`),sample,"utf8");

  console.log("✔  statistics written (csv, txt, exists_forms/)");
})();
