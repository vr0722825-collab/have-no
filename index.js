const express = require("express");
const crypto = require("crypto");

const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

function startFirebase() {
  if (getApps().length) return;

  const key = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!key) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
  }

  initializeApp({
    credential: cert(JSON.parse(key))
  });
}

startFirebase();

const db = getFirestore();
const app = express();

app.use(express.json());

const USERS = ["vicky","raajan","obito","alpha"];
const PASSWORD = "4Friends";
const SECRET = process.env.SESSION_SECRET || "budget-secret-2026";
const DEFAULT_BUDGET = 2000;

const DEFAULT_ITEMS = [
  "Vegetables",
  "Chicken",
  "Water",
  "Electric bill",
  "Home things"
];

function uid(){
  return crypto.randomBytes(16).toString("hex");
}

function userDoc(username){
  return db.collection("users").doc(username);
}

function itemCol(username){
  return userDoc(username).collection("items");
}

function spendCol(username){
  return userDoc(username).collection("spends");
}

function budgetCol(username){
  return userDoc(username).collection("budgets");
}

function monthValid(m){
  return /^\d{4}-\d{2}$/.test(m || "");
}

function nextMonth(m){
  const [y,mo]=m.split("-").map(Number);
  const d=new Date(y,mo-1,1);
  d.setMonth(d.getMonth()+1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

function monthName(m){
  const [y,mo]=m.split("-").map(Number);
  return new Date(y,mo-1,1).toLocaleString("en-IN",{month:"long",year:"numeric"});
}

function sign(v){
  return crypto.createHmac("sha256",SECRET).update(v).digest("hex");
}

function makeCookie(username){
  const payload=Buffer.from(JSON.stringify({
    username,
    exp:Date.now()+2592000000
  })).toString("base64url");

  return payload+"."+sign(payload);
}

function readCookie(req){
  const all=req.headers.cookie||"";

  for(const p of all.split(";")){
    const [k,...v]=p.trim().split("=");
    if(k==="budget_auth") return decodeURIComponent(v.join("="));
  }

  return null;
}

function currentUser(req){
  const c=readCookie(req);
  if(!c) return null;

  const parts=c.split(".");
  if(parts.length!==2) return null;

  if(sign(parts[0])!==parts[1]) return null;

  try{
    const data=JSON.parse(Buffer.from(parts[0],"base64url").toString());
    if(data.exp<Date.now()) return null;
    if(!USERS.includes(data.username)) return null;
    return data.username;
  }catch{
    return null;
  }
}

function auth(req,res,next){
  const u=currentUser(req);

  if(!u){
    return res.status(401).json({error:"Please login"});
  }

  req.username=u;
  next();
}

async function setupUser(username){
  const ref=userDoc(username);
  const user=await ref.get();

  if(!user.exists){
    await ref.set({
      username,
      createdAt:FieldValue.serverTimestamp()
    });
  }

  const items=await itemCol(username).get();

  if(items.empty){
    const batch=db.batch();

    DEFAULT_ITEMS.forEach(name=>{
      batch.set(itemCol(username).doc(uid()),{
        name,
        isDefault:true,
        createdAt:FieldValue.serverTimestamp()
      });
    });

    await batch.commit();
  }
}

async function totalSpent(username,month){
  const s=await spendCol(username).where("month","==",month).get();

  let total=0;

  s.forEach(d=>{
    total+=Number(d.data().amount||0);
  });

  return total;
}

async function budget(username,month){
  const b=await budgetCol(username).doc(month).get();

  return b.exists?Number(b.data().amount):DEFAULT_BUDGET;
}

app.post("/api/login",async(req,res)=>{
  const username=String(req.body.username||"").toLowerCase().trim();
  const password=String(req.body.password||"");

  if(!USERS.includes(username)||password!==PASSWORD){
    return res.status(400).json({error:"Wrong username or password"});
  }

  await setupUser(username);

  const cookie=makeCookie(username);

  res.setHeader("Set-Cookie",
    "budget_auth="+encodeURIComponent(cookie)+"; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
  );

  res.json({username});
});

app.post("/api/logout",(req,res)=>{
  res.setHeader("Set-Cookie","budget_auth=; Path=/; Max-Age=0");
  res.json({ok:true});
});

app.get("/api/me",(req,res)=>{
  const u=currentUser(req);

  if(!u) return res.status(401).json({error:"Not logged in"});

  res.json({username:u});
});

app.get("/api/month",auth,async(req,res)=>{
  const month=req.query.month;

  if(!monthValid(month)){
    return res.status(400).json({error:"Invalid month"});
  }

  const username=req.username;

  const b=await budget(username,month);
  const spent=await totalSpent(username,month);

  const next=nextMonth(month);

  const nb=await budget(username,next);
  const ns=await totalSpent(username,next);

  const itemsSnap=await itemCol(username).get();

  const items=[];

  itemsSnap.forEach(d=>{
    items.push({
      id:d.id,
      name:d.data().name,
      isDefault:d.data().isDefault,
      spent:0,
      nextSpent:0,
      spends:[]
    });
  });

  const map=new Map();

  items.forEach(i=>map.set(i.id,i));

  const spends=await spendCol(username).where("month","==",month).get();

  spends.forEach(d=>{
    const x=d.data();
    const item=map.get(x.itemId);

    if(item){
      item.spent+=Number(x.amount);
      item.spends.push({
        id:d.id,
        amount:x.amount,
        note:x.note||"",
        spentOn:x.spentOn
      });
    }
  });

  const nextSpends=await spendCol(username).where("month","==",next).get();

  nextSpends.forEach(d=>{
    const x=d.data();
    const item=map.get(x.itemId);
    if(item) item.nextSpent+=Number(x.amount);
  });

  items.forEach(i=>{
    i.spends.sort((a,b)=>b.spentOn.localeCompare(a.spentOn));
  });

  items.sort((a,b)=>a.name.localeCompare(b.name));

  res.json({
    month,
    label:monthName(month),
    budget:b,
    spent,
    leftover:b-spent,
    next:{
      month:next,
      label:monthName(next),
      budget:nb,
      spent:ns,
      leftover:nb-ns
    },
    items
  });
});

app.put("/api/budget",auth,async(req,res)=>{
  const month=req.body.month;
  const amount=Number(req.body.amount);

  if(!monthValid(month)||amount<0){
    return res.status(400).json({error:"Invalid budget"});
  }

  await budgetCol(req.username).doc(month).set({
    amount,
    updatedAt:FieldValue.serverTimestamp()
  });

  res.json({ok:true});
});

app.post("/api/items",auth,async(req,res)=>{
  const name=String(req.body.name||"").trim();

  if(!name){
    return res.status(400).json({error:"Enter item name"});
  }

  const all=await itemCol(req.username).get();

  for(const d of all.docs){
    if(d.data().name.toLowerCase()===name.toLowerCase()){
      return res.status(400).json({error:"Item already exists"});
    }
  }

  const id=uid();

  await itemCol(req.username).doc(id).set({
    name,
    isDefault:false
  });

  res.json({id,name});
});

app.patch("/api/items/:id",auth,async(req,res)=>{
  const id=req.params.id;
  const name=String(req.body.name||"").trim();

  await itemCol(req.username).doc(id).update({name});

  res.json({ok:true});
});

app.delete("/api/items/:id",auth,async(req,res)=>{
  const id=req.params.id;

  const spends=await spendCol(req.username).where("itemId","==",id).get();

  const batch=db.batch();

  spends.forEach(d=>batch.delete(d.ref));

  batch.delete(itemCol(req.username).doc(id));

  await batch.commit();

  res.json({ok:true});
});

app.post("/api/spends",auth,async(req,res)=>{
  const {month,itemId,amount,note,spentOn}=req.body;

  if(!monthValid(month)||Number(amount)<=0){
    return res.status(400).json({error:"Invalid data"});
  }

  const id=uid();

  await spendCol(req.username).doc(id).set({
    month,
    itemId,
    amount:Number(amount),
    note:note||"",
    spentOn,
    createdAt:FieldValue.serverTimestamp()
  });

  res.json({ok:true});
});

app.delete("/api/spends/:id",auth,async(req,res)=>{
  await spendCol(req.username).doc(req.params.id).delete();
  res.json({ok:true});
});

const html = String.raw`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Home Budget</title>

<style>

*{box-sizing:border-box}

body{
margin:0;
font-family:Arial;
background:#eef2f7;
color:#222
}

.hidden{display:none}

header{
background:#5865f2;
color:white;
padding:15px;
display:flex;
justify-content:space-between;
align-items:center
}

.container{
max-width:900px;
margin:auto;
padding:20px
}

.card{
background:white;
border-radius:15px;
padding:18px;
margin-bottom:18px;
box-shadow:0 4px 15px rgba(0,0,0,.08)
}

.grid{
display:grid;
grid-template-columns:repeat(3,1fr);
gap:15px
}

.stat{
font-size:28px;
font-weight:bold
}

input,button{
padding:12px;
border-radius:10px;
border:1px solid #ddd;
font-size:16px
}

button{
background:#5865f2;
color:white;
border:none
}

.item{
background:white;
padding:15px;
border-radius:14px;
margin-bottom:12px
}

.row{
display:flex;
justify-content:space-between;
gap:10px;
align-items:center
}

.progress{
height:8px;
background:#ddd;
border-radius:10px;
margin:10px 0
}

.bar{
height:100%;
background:#5865f2;
border-radius:10px
}

.spend{
border-top:1px solid #eee;
padding:8px 0
}

.login{
max-width:380px;
margin:100px auto;
background:white;
padding:25px;
border-radius:18px
}

@media(max-width:600px){

.grid{
grid-template-columns:1fr
}

}

</style>
</head>

<body>

<div id="loginPage" class="login">

<h2>💰 Home Budget</h2>

<input id="username" placeholder="Username">

<br><br>

<input id="password" type="password" placeholder="Password">

<br><br>

<button onclick="login()">Login</button>

<p id="error" style="color:red"></p>

</div>

<div id="app" class="hidden">

<header>

<b>💰 Home Budget</b>

<div>

<span id="user"></span>

<button onclick="logout()">Logout</button>

</div>

</header>

<div class="container">

<div class="card">

<div class="row">

<h2 id="monthTitle"></h2>

<input type="month" id="monthPicker">

</div>

</div>

<div class="grid">

<div class="card">

Budget

<div id="budget" class="stat">₹0</div>

</div>

<div class="card">

Spent

<div id="spent" class="stat">₹0</div>

</div>

<div class="card">

Remaining

<div id="remaining" class="stat">₹0</div>

</div>

</div>

<div class="card">

<h3>Set Budget</h3>

<input id="budgetInput" type="number">

<button onclick="saveBudget()">Save</button>

</div>

<div class="card">

<h3>Add New Item</h3>

<input id="newItem" placeholder="Item name">

<button onclick="addItem()">Add</button>

</div>

<div id="items"></div>

<div class="card">

<h3>Next Month</h3>

<div id="next"></div>

</div>

</div>

</div>

<script>

let currentMonth="";

function api(url,opt={}){
opt.headers={"Content-Type":"application/json"};
return fetch(url,opt).then(async r=>{
const d=await r.json();
if(!r.ok)throw new Error(d.error);
return d;
});
}

function money(v){
return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(v||0);
}

function monthNow(){
const d=new Date();
return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

async function login(){

try{

const d=await api("/api/login",{
method:"POST",
body:JSON.stringify({
username:username.value,
password:password.value
})
});

user.textContent=d.username;

loginPage.classList.add("hidden");

app.classList.remove("hidden");

currentMonth=monthNow();

monthPicker.value=currentMonth;

load();

}catch(e){

error.textContent=e.message;

}

}

async function logout(){

await api("/api/logout",{method:"POST"});

location.reload();

}

async function load(){

const d=await api("/api/month?month="+currentMonth);

monthTitle.textContent=d.label;

budget.textContent=money(d.budget);

spent.textContent=money(d.spent);

remaining.textContent=money(d.leftover);

budgetInput.value=d.budget;

items.innerHTML="";

d.items.forEach(i=>{

const el=document.createElement("div");

el.className="item";

let percent=d.budget?Math.min(100,i.spent/d.budget*100):0;

el.innerHTML=
"<div class='row'>"+
"<b>"+i.name+"</b>"+
"<span>"+money(i.spent)+"</span>"+
"</div>"+
"<div class='progress'><div class='bar' style='width:"+percent+"%'></div></div>"+
"<button onclick='addSpend(\""+i.id+"\")'>Add Spending</button>"+
" <button onclick='editItem(\""+i.id+"\",\""+i.name+"\")'>Edit</button>"+
" <button onclick='deleteItem(\""+i.id+"\")'>Delete</button>"+
"<div id='s"+i.id+"'></div>";

items.appendChild(el);

const box=document.getElementById("s"+i.id);

i.spends.forEach(s=>{

box.innerHTML+=
"<div class='spend'>"+
money(s.amount)+" - "+
(s.note||"")+" ("+s.spentOn+") "+
"<button onclick='deleteSpend(\""+s.id+"\")'>Delete</button>"+
"</div>";

});

});

next.innerHTML=
"<b>"+d.next.label+"</b><br>"+
"Budget: "+money(d.next.budget)+"<br>"+
"Spent: "+money(d.next.spent);

}

async function saveBudget(){

await api("/api/budget",{
method:"PUT",
body:JSON.stringify({
month:currentMonth,
amount:Number(budgetInput.value)
})
});

load();

}

async function addItem(){

if(!newItem.value)return;

await api("/api/items",{
method:"POST",
body:JSON.stringify({name:newItem.value})
});

newItem.value="";

load();

}

async function editItem(id,name){

const n=prompt("New name",name);

if(!n)return;

await api("/api/items/"+id,{
method:"PATCH",
body:JSON.stringify({name:n})
});

load();

}

async function deleteItem(id){

if(!confirm("Delete item?"))return;

await api("/api/items/"+id,{method:"DELETE"});

load();

}

async function addSpend(id){

const amount=prompt("Amount");

if(!amount)return;

const note=prompt("Note")||"";

const date=prompt("Date YYYY-MM-DD",new Date().toISOString().slice(0,10));

await api("/api/spends",{
method:"POST",
body:JSON.stringify({
month:currentMonth,
itemId:id,
amount:Number(amount),
note,
spentOn:date
})
});

load();

}

async function deleteSpend(id){

await api("/api/spends/"+id,{method:"DELETE"});

load();

}

monthPicker.onchange=()=>{
currentMonth=monthPicker.value;
load();
};

(async()=>{

try{

const d=await api("/api/me");

user.textContent=d.username;

loginPage.classList.add("hidden");

app.classList.remove("hidden");

currentMonth=monthNow();

monthPicker.value=currentMonth;

load();

}catch{}

})();

</script>

</body>
</html>
`;

app.get("*",(req,res)=>{
  res.send(html);
});

module.exports=app;