require("dotenv").config();
const express=require('express');
const session=require('express-session');
const fs=require('fs'); const path=require('path'); const crypto=require('crypto');
const {spawn,spawnSync}=require('child_process'); const https=require('https'); const querystring=require('querystring'); const mysql=require('mysql2/promise');
const app=express();
const PORT=Number(process.env.PORT||3000), ROOT=__dirname;
const DATA_DIR=path.resolve(process.env.DATA_DIR||path.join(ROOT,'data')), RUNTIME_DIR=path.join(DATA_DIR,'runtime');
const USERS_FILE=path.join(DATA_DIR,'users.json');
const IS_PRODUCTION=process.env.NODE_ENV==='production';
const SESSION_SECRET=process.env.SESSION_SECRET||'tinshi-change-this-secret';
const CONTROL_BOT_TOKEN=String(process.env.CONTROL_BOT_TOKEN||'').trim();
const CONTROL_BOT_OWNER_ID=String(process.env.CONTROL_BOT_OWNER_ID||'1518966127546339439').trim() || '1518966127546339439';
const CONTROL_BOT_SECRET=String(process.env.CONTROL_BOT_SECRET||crypto.randomBytes(32).toString('hex')).trim();
const PUBLIC_BASE_URL=String(process.env.PUBLIC_BASE_URL||'').trim().replace(/\/$/,'');

// Railway MySQL
let dbPool = null;
let dbState = { connected: false, error: null, host: null, database: null };

function databaseUrl() {
  return String(process.env.DATABASE_PUBLIC_URL || process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL || process.env.MYSQL_URL || '').trim();
}

function mysqlConfig(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'mysql:') throw new Error('DATABASE_URL must start with mysql://');
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database: decodeURIComponent((u.pathname || '/railway').replace(/^\//, '')) || 'railway',
    ssl: u.hostname.endsWith('.railway.internal') ? undefined : { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000
  };
}

async function initDatabaseOnce() {
  const raw = databaseUrl();
  if (!raw) {
    dbState = { connected:false, error:'DATABASE_URL is not set', host:null, database:null };
    console.warn('[DB] DATABASE_URL is not set');
    return false;
  }
  try {
    const cfg = mysqlConfig(raw);
    dbPool = mysql.createPool(cfg);
    await dbPool.query('SELECT 1');
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tinshi_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin TINYINT(1) DEFAULT 0,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        premium_until DATETIME NULL,
        slot_count INT NOT NULL DEFAULT 1,
        payment_json LONGTEXT NULL,
        discord_id VARCHAR(32) NULL,
        web_token_hash VARCHAR(128) NULL,
        web_token_expires DATETIME NULL,
        trail_used TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const sql of [
      "ALTER TABLE tinshi_users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user'",
      "ALTER TABLE tinshi_users ADD COLUMN premium_until DATETIME NULL",
      "ALTER TABLE tinshi_users ADD COLUMN slot_count INT NOT NULL DEFAULT 1",
      "ALTER TABLE tinshi_users ADD COLUMN payment_json LONGTEXT NULL",
      "ALTER TABLE tinshi_users ADD COLUMN discord_id VARCHAR(32) NULL",
      "ALTER TABLE tinshi_users ADD COLUMN web_token_hash VARCHAR(128) NULL",
      "ALTER TABLE tinshi_users ADD COLUMN web_token_expires DATETIME NULL",
      "ALTER TABLE tinshi_users ADD COLUMN trail_used TINYINT(1) NOT NULL DEFAULT 0"
    ]) { try { await dbPool.query(sql); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; } }
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tinshi_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        plan VARCHAR(50) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(30) NOT NULL DEFAULT 'LTC',
        txid VARCHAR(255) DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP NULL,
        slots INT NOT NULL DEFAULT 1
      )
    `);
    const existingAdmin = await dbUser(ADMIN_USERNAME);
    if (!existingAdmin) {
      await dbPool.query('INSERT INTO tinshi_users (username,password_hash,is_admin,role,slot_count) VALUES (?,?,?,?,1)', [ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), 1, 'admin']);
    } else if (!existingAdmin.password_hash || !String(existingAdmin.password_hash).startsWith('scrypt$')) {
      await dbPool.query("UPDATE tinshi_users SET password_hash=?,is_admin=1,role='admin' WHERE username=?", [hashPassword(ADMIN_PASSWORD), ADMIN_USERNAME]);
    }
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tinshi_bots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        bot_name VARCHAR(100) NOT NULL,
        bot_token TEXT NOT NULL,
        owner_id VARCHAR(100) DEFAULT '',
        channel_id VARCHAR(100) DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'stopped',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS tinshi_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value TEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    dbState = { connected:true, error:null, host:cfg.host, database:cfg.database };
    console.log(`[DB] MySQL connected: ${cfg.host}:${cfg.port}/${cfg.database}`);
    return true;
  } catch (e) {
    dbPool = null;
    dbState = { connected:false, error:e.message, host:null, database:null };
    console.error('[DB] MySQL connection failed:', e.message);
    return false;
  }
}

async function initDatabase() {
  let last = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (await initDatabaseOnce()) return true;
    last = dbState.error;
    if (attempt < 5) {
      console.warn(`[DB] connection attempt ${attempt}/5 failed; retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  dbState.error = last || 'Database connection failed';
  return false;
}

async function dbUser(username) {
  if (!dbPool) return null;
  const [rows] = await dbPool.query('SELECT * FROM tinshi_users WHERE username=? LIMIT 1', [username]);
  return rows[0] || null;
}

async function paidPlan(username) {
  if (!dbPool) return null;
  const [rows] = await dbPool.query(
    "SELECT * FROM tinshi_payments WHERE username=? AND status='approved' ORDER BY approved_at DESC, id DESC LIMIT 1",
    [username]
  );
  return rows[0] || null;
}
const FRONTEND_ORIGIN=String(process.env.FRONTEND_ORIGIN||'').trim().replace(/\/$/,'');
const BACKEND_URL=String(process.env.BACKEND_URL||'').trim().replace(/\/$/,'');
const SESSION_SAME_SITE=FRONTEND_ORIGIN?'none':'lax';
const LTC_ADDRESS=String(process.env.LTC_ADDRESS||'ltc1qzqnep99a9p88lm0330n4hrcz38av2qs870sc2y').trim();
const MONTHLY_PRICE_USD=8, EXTRA_SLOT_PRICE_USD=4, PREMIUM_DAYS=30;
const ADMIN_USERNAME=String(process.env.ADMIN_USERNAME||'admin').trim();
const ADMIN_PASSWORD=String(process.env.ADMIN_PASSWORD||'admin123');
const BOT_TEMPLATE=path.join(ROOT,'bot-template');
fs.mkdirSync(DATA_DIR,{recursive:true}); fs.mkdirSync(RUNTIME_DIR,{recursive:true});
function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const derived=crypto.scryptSync(String(password),salt,64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(password,stored){
  if(!stored)return false;
  if(stored.startsWith('scrypt$')){
    const [,salt,hex]=stored.split('$');
    if(!salt||!hex)return false;
    const actual=crypto.scryptSync(String(password),salt,64);
    const expected=Buffer.from(hex,'hex');
    return expected.length===actual.length && crypto.timingSafeEqual(actual,expected);
  }
  return false;
}
function userFromRow(r){
  if(!r)return null;
  let payment=null; try{payment=r.payment_json?JSON.parse(r.payment_json):null}catch{}
  return {username:r.username,password_hash:r.password_hash,role:r.role||(r.is_admin?'admin':'user'),premiumUntil:r.premium_until?new Date(r.premium_until).toISOString():null,payment,slotCount:Number(r.slot_count||1),createdAt:r.created_at,discordId:String(r.discord_id||''),webTokenHash:String(r.web_token_hash||''),webTokenExpires:r.web_token_expires?new Date(r.web_token_expires).toISOString():null,trailUsed:Number(r.trail_used||0)===1};
}
async function findUser(n){
  if(!dbPool)return null;
  return userFromRow(await dbUser(String(n).trim()));
}
async function saveUser(u){
  if(!dbPool)throw Error('Database not connected');
  await dbPool.query('UPDATE tinshi_users SET role=?, is_admin=?, premium_until=?, slot_count=?, payment_json=? WHERE username=?',[u.role||'user',u.role==='admin'?1:0,u.premiumUntil?new Date(u.premiumUntil):null,Math.max(1,Number(u.slotCount||1)),u.payment?JSON.stringify(u.payment):null,u.username]);
}
async function ensureDiscordAccount(discordId){
  const did=String(discordId||'').trim();
  if(!validId(did))throw Error('Invalid Discord user ID.');
  if(!dbPool)throw Error('Database not connected');
  const username='dc_'+did;
  let u=await findUser(username);
  if(!u){
    const temp=crypto.randomBytes(18).toString('base64url');
    await dbPool.query('INSERT INTO tinshi_users (username,password_hash,is_admin,role,slot_count,discord_id,trail_used) VALUES (?,?,?,?,?,?,0)',[username,hashPassword(temp),0,'user',1,did]);
    u=await findUser(username);
  }else if(u.discordId!==did){
    await dbPool.query('UPDATE tinshi_users SET discord_id=? WHERE username=?',[did,username]);
    u=await findUser(username);
  }
  return u;
}

async function ensureTrialAccount(discordId){
  const u=await ensureDiscordAccount(discordId);
  if(u.trailUsed)throw Error('Your 24-hour trial has already been used.');
  if(activeAccess(u))throw Error('You already have active access.');
  const until=new Date(Date.now()+24*60*60*1000);
  await dbPool.query('UPDATE tinshi_users SET premium_until=?,slot_count=?,trail_used=1 WHERE username=?',[until,Math.max(1,Number(u.slotCount||1)),u.username]);
  return await findUser(u.username);
}

function premiumUntil(u){const t=Date.parse(u?.premiumUntil||'');return Number.isFinite(t)&&t>Date.now()?new Date(t):null}
function hasPremium(u){return u?.role==='admin'||!!premiumUntil(u)}
function publicUser(u){return {username:u.username,role:u.role||'user',discordId:u.discordId||'',premium:hasPremium(u),premiumUntil:premiumUntil(u)?.toISOString()||null,paymentStatus:u.payment?.status||'none'}}
function auth(req,res,next){if(!req.session.user)return res.status(401).json({error:'Login required'});next()}
async function admin(req,res,next){if(!req.session.user)return res.status(403).json({error:'Admin access required'});const u=await findUser(req.session.user.username);if(!u||u.role!=='admin')return res.status(403).json({error:'Admin access required'});req.currentUser=u;next()}
async function premium(req,res,next){if(!req.session.user)return res.status(401).json({error:'Login required'});const u=await findUser(req.session.user.username);if(!u||!hasPremium(u))return res.status(402).json({error:'Premium access required.',code:'PREMIUM_REQUIRED'});req.currentUser=u;next()}
function userDir(u){return path.join(RUNTIME_DIR,String(u.username).toLowerCase().replace(/[^a-z0-9_-]/g,'_'))}
function cfgPath(u){return path.join(userDir(u),'config.json')}
function cfg(u){try{return JSON.parse(fs.readFileSync(cfgPath(u),'utf8'))}catch{return {token:'',ownerId:'',channelId:'',owners:[]}}}
function botDir(u,id){return path.join(userDir(u),'bots',String(id))}
function botCfgPath(u,id){return path.join(botDir(u,id),'config.json')}
function cfgForBot(u,id){try{return JSON.parse(fs.readFileSync(botCfgPath(u,id),'utf8'))}catch{return {token:'',ownerId:'',channelId:'',owners:[]}}}
function makeTemplateConfig(x){
  const token=String(x.token||'').trim();
  const ownerId=String(x.ownerId||'').trim();
  const channelId=String(x.channelId||'').trim();
  const ids=[ownerId,...(Array.isArray(x.owners)?x.owners:[])].map(v=>String(v).trim()).filter(v=>/^\d{15,22}$/.test(v));
  const owners=[...new Set(ids)];
  const ownerValue=/^\d{15,22}$/.test(ownerId)?ownerId:ownerId;
  const channelValue=/^\d{15,22}$/.test(channelId)?Number(channelId):channelId;
  return {
    ownerId:ownerValue,
    owner_id:ownerValue,
    channelId:channelValue,
    token,
    owners,
    tokens:{bot_token:token},
    discord:{accounts_channel:channelValue,owner_id:ownerValue},
    autosecure:{replace_main_alias:true}
  };
}
function ensureBotRuntime(u,id){
  const d=botDir(u,id), bot=path.join(d,'runtime');
  fs.rmSync(bot,{recursive:true,force:true});
  fs.mkdirSync(bot,{recursive:true});
  fs.cpSync(BOT_TEMPLATE,bot,{recursive:true,force:true});
  const cp=botCfgPath(u,id);
  if(fs.existsSync(cp)) fs.copyFileSync(cp,path.join(bot,'config.json'));
  return {d,bot};
}
function writeBotCfg(u,id,x){
  const d=botDir(u,id);
  fs.mkdirSync(d,{recursive:true});
  const normalized={...x,ownerId:String(x.ownerId||'').trim(),channelId:String(x.channelId||'').trim(),token:String(x.token||'').trim(),owners:[String(x.ownerId||'').trim()]};
  const text=JSON.stringify(makeTemplateConfig(normalized),null,4);
  fs.writeFileSync(botCfgPath(u,id),text,{encoding:'utf8',mode:0o600});
  const runtime=path.join(d,'runtime');
  if(fs.existsSync(runtime)) fs.writeFileSync(path.join(runtime,'config.json'),text,{encoding:'utf8',mode:0o600});
}
function ensureRuntime(u){const d=userDir(u),bot=path.join(d,'bot');fs.mkdirSync(bot,{recursive:true});fs.mkdirSync(path.join(bot,'database'),{recursive:true});return {d,bot}}
function writeCfg(u,x){ensureRuntime(u);fs.writeFileSync(cfgPath(u),JSON.stringify(x,null,2))}
function validId(x){return /^\d{15,22}$/.test(String(x||''))}
function hiddenOwnerId(u){const d=String(u?.discordId||'').trim();if(validId(d))return d;return validId(CONTROL_BOT_OWNER_ID)?CONTROL_BOT_OWNER_ID:''}
function activeAccess(u){return !!u && (u.role==='admin' || !!premiumUntil(u))}
function userForDiscord(discordId){return dbUser('dc_'+String(discordId).trim())}
async function issueWebLogin(u,baseOverride=''){const raw=crypto.randomBytes(32).toString('hex');const hash=crypto.createHash('sha256').update(raw).digest('hex');const exp=new Date(Date.now()+15*60*1000);await dbPool.query('UPDATE tinshi_users SET web_token_hash=?,web_token_expires=? WHERE username=?',[hash,exp,u.username]);const base=String(baseOverride||PUBLIC_BASE_URL||BACKEND_URL||'').replace(/\/$/,'');return {token:raw,url:base?`${base}/auth/discord?token=${encodeURIComponent(raw)}`:''}}
function makeWebPassword(){return crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g,'').slice(0,14)+'A9!'}
async function resetWebCredentials(u){const password=makeWebPassword();await dbPool.query('UPDATE tinshi_users SET password_hash=? WHERE username=?',[hashPassword(password),u.username]);return {username:u.username,password}}
async function getSetting(key){if(!dbPool)return '';const [rows]=await dbPool.query('SELECT setting_value FROM tinshi_settings WHERE setting_key=? LIMIT 1',[key]);return String(rows[0]?.setting_value||'').trim()}
async function setSetting(key,value){if(!dbPool)throw Error('Database not connected');await dbPool.query('INSERT INTO tinshi_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,String(value||'').trim()])}
function validateToken(token){return new Promise(resolve=>{if(!token)return resolve({ok:false,message:'Bot token is required.'});const r=https.request({hostname:'discord.com',path:'/api/v10/users/@me',headers:{Authorization:`Bot ${token}`,'User-Agent':'TINSHI-BOT-CLOUD'}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>{if(res.statusCode===200){try{const x=JSON.parse(b);resolve({ok:true,username:x.username||'Discord Bot',id:x.id||''})}catch{resolve({ok:true,username:'Discord Bot',id:''})}}else resolve({ok:false,message:res.statusCode===401?'Discord token is invalid or revoked.':`Discord returned HTTP ${res.statusCode}.`})})});r.setTimeout(10000,()=>{r.destroy();resolve({ok:false,message:'Discord token check timed out.'})});r.on('error',()=>resolve({ok:false,message:'Could not reach Discord.'}));r.end()})}
const jobs=new Map();
function key(u,id){return `${String(u.username).toLowerCase()}:${String(id||'')}`} function job(u,id){return jobs.get(key(u,id))} function alive(j){return !!j?.child&&j.child.exitCode===null&&!j.child.killed}
function emit(j,line,type='system'){const text=String(line).replace(/\r/g,'').trimEnd();if(!text)return;const item={time:new Date().toISOString(),type,line:text};j.logs.push(item);if(j.logs.length>800)j.logs.shift();for(const r of j.clients){try{r.write(`data: ${JSON.stringify(item)}\n\n`)}catch{}};console.log(`[BOT ${j.user}] ${text}`)}
function setupEnv(j){const v=path.join(j.bot,'.venv'),py=path.join(v,'bin','python');if(!fs.existsSync(py)){const r=spawnSync('python3',['-m','venv',v],{cwd:j.bot,encoding:'utf8'});if(r.status!==0)throw Error('python3-venv is required on the server.')}emit(j,'Installing bot dependencies...');const r=spawnSync(py,['-m','pip','install','--disable-pip-version-check','-q','-r','requirements.txt'],{cwd:j.bot,encoding:'utf8',stdio:['ignore','pipe','pipe']});if(r.status!==0){const detail=String(r.stderr||r.stdout||'').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');throw Error(`Python dependencies could not be installed.${detail?' '+detail:''}`)}emit(j,'Dependencies ready.')}
app.set('trust proxy',1); app.use(express.json({limit:'100kb'}));
app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');if(FRONTEND_ORIGIN){res.setHeader('Access-Control-Allow-Origin',FRONTEND_ORIGIN);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin')}if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');return res.sendStatus(204)}next()});
app.use(session({secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:SESSION_SAME_SITE,secure:IS_PRODUCTION||!!FRONTEND_ORIGIN,maxAge:86400000}}));
// Server-side route guard: every HTML page except the login page requires a valid session.
app.use((req,res,next)=>{
  if(req.method==='GET' && req.path.endsWith('.html') && req.path!=='/index.html' && !req.session.user){
    return res.redirect('/');
  }
  next();
});
app.use(express.static(path.join(ROOT,'public')));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'TINSHI BOT CLOUD'}));
app.get('/api/public-config',(req,res)=>res.json({ok:true,backendUrl:BACKEND_URL||`${req.protocol}://${req.get('host')}`}));
app.get('/api/me',async(req,res)=>{const u=req.session.user?await findUser(req.session.user.username):null;res.json({ok:true,loggedIn:!!u,user:u?publicUser(u):null})});
app.post('/api/login',async(req,res)=>{try{const n=String(req.body?.username||'').trim(),p=String(req.body?.password||'');const u=await findUser(n);if(!u||!verifyPassword(p,u.password_hash))return res.status(401).json({error:'Invalid username or password'});req.session.user={username:u.username,role:u.role};ensureRuntime(u);res.json({ok:true,user:publicUser(u)})}catch(e){res.status(500).json({error:'Login service unavailable.'})}});
app.post('/api/register',async(req,res)=>{try{const n=String(req.body?.username||'').trim(),p=String(req.body?.password||''),p2=String(req.body?.password2||'');if(!/^[A-Za-z0-9_]{3,32}$/.test(n))return res.status(400).json({error:'Username must be 3-32 characters.'});if(p.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'});if(p!==p2)return res.status(400).json({error:'Passwords do not match.'});if(!dbPool)return res.status(503).json({error:'Database not connected.'});if(await findUser(n))return res.status(409).json({error:'Username already exists.'});await dbPool.query('INSERT INTO tinshi_users (username,password_hash,is_admin,role,slot_count) VALUES (?,?,?,?,1)',[n,hashPassword(p),0,'user']);const created=await findUser(n);req.session.user={username:created.username,role:created.role};ensureRuntime(created);res.json({ok:true,user:publicUser(created)})}catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'Username already exists.'});res.status(500).json({error:'Registration service unavailable.'})}});
app.post('/api/logout',auth,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/account',auth,async(req,res)=>{const u=await findUser(req.session.user.username);let totalSlots=hasPremium(u)?Math.max(1,Number(u.slotCount||1)):0;let usedSlots=0;if(dbPool){try{const [r]=await dbPool.query('SELECT COUNT(*) AS n FROM tinshi_bots WHERE username=?',[u.username]);usedSlots=Number(r[0]?.n||0)}catch{}}res.json({ok:true,username:u.username,premium:hasPremium(u),premiumUntil:premiumUntil(u)?.toISOString()||null,totalSlots,usedSlots,availableSlots:Math.max(0,totalSlots-usedSlots),plan:hasPremium(u)?'Premium':'Free',monthlyPrice:8,extraSlotPrice:4,paymentStatus:u.payment?.status||'none',paymentAmount:u.payment?.amountUsd||null})});
app.get('/api/premium',auth,async(req,res)=>{const u=await findUser(req.session.user.username);res.json({ok:true,priceUsd:MONTHLY_PRICE_USD,days:PREMIUM_DAYS,ltcAddress:LTC_ADDRESS,premium:hasPremium(u),premiumUntil:premiumUntil(u)?.toISOString()||null,payment:u.payment||null})});
app.post('/api/payment/submit',auth,async(req,res)=>{const txid=String(req.body?.txid||'').trim();const amount=Number(req.body?.amount||8);if(!/^[A-Za-z0-9]{20,128}$/.test(txid))return res.status(400).json({error:'Enter a valid Litecoin transaction ID.'});if(![8,4].includes(amount))return res.status(400).json({error:'Payment amount must be $8 or $4.'});const u=await findUser(req.session.user.username);if(amount===8&&hasPremium(u))return res.status(409).json({error:'Premium is already active. Use the $4 slot option.'});if(amount===4&&!hasPremium(u))return res.status(402).json({error:'Activate the $8 monthly plan first.',code:'PREMIUM_REQUIRED'});u.payment={status:'pending',txid,submittedAt:new Date().toISOString(),amountUsd:amount,network:'Litecoin',type:amount===8?'premium':'slot'};await saveUser(u);if(dbPool)await dbPool.query('INSERT INTO tinshi_payments (username,plan,amount,method,txid,status,slots) VALUES (?,?,?,?,?,?,1)',[u.username,amount===8?'monthly':'extra_slot',amount,'LTC',txid,'pending']);res.json({ok:true,message:amount===8?'Payment submitted. Your $8 monthly plan is awaiting admin approval.':'Slot payment submitted. Your extra slot is awaiting admin approval.'})});
app.get('/api/config',premium,(req,res)=>res.status(410).json({error:'Bot configuration is per-bot. Use the Add Bot form.'}));
app.post('/api/config/verify',premium,(req,res)=>res.status(410).json({error:'Bot configuration is verified during Add Bot.'}));
app.post('/api/config',premium,(req,res)=>res.status(410).json({error:'Bot configuration is per-bot. Use the Add Bot form.'}));
app.get('/api/status',premium,async(req,res)=>{
  const id=Number(req.query.id||0); if(!id)return res.status(400).json({error:'Bot ID is required.'});
  let bot; try{const [rows]=await dbPool.query('SELECT id,bot_name,status FROM tinshi_bots WHERE id=? AND username=? LIMIT 1',[id,req.session.user.username]);bot=rows[0]}catch{}
  if(!bot)return res.status(404).json({error:'Bot not found.'});
  const j=job(req.session.user,id),c=cfgForBot(req.session.user,id),st=alive(j)?'running':(j?.state||bot.status||'stopped');
  res.json({ok:true,botId:id,state:st,pid:j?.child?.pid||null,startedAt:j?.startedAt||null,config:!!(c.token&&validId(c.ownerId)&&validId(c.channelId)),uptime:j?.startedAt&&alive(j)?Date.now()-Date.parse(j.startedAt):0});
});
app.get('/api/console',premium,async(req,res)=>{
  const id=Number(req.query.id||0); if(!id)return res.status(400).json({error:'Bot ID is required.'});
  const j=job(req.session.user,id);
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify(j?.logs||[])}\n\n`);
  if(j){j.clients.add(res);req.on('close',()=>j.clients.delete(res))}
});
app.post('/api/console/clear',premium,(req,res)=>{
  const id=Number(req.body?.bot_id||0);const j=job(req.session.user,id);if(j){j.logs=[];emit(j,'Console cleared.')}res.json({ok:true});
});
async function startBotForUser(u,id){
  const [rows]=await dbPool.query('SELECT * FROM tinshi_bots WHERE id=? AND username=? LIMIT 1',[id,u.username]);const botRow=rows[0];if(!botRow)throw Error('Bot not found.');
  let j=job(u,id);if(alive(j))return {alreadyRunning:true};
  const c=cfgForBot(u,id);
  const effective={token:String(botRow.bot_token||c.token||'').trim(),ownerId:String(botRow.owner_id||c.ownerId||hiddenOwnerId(u)).trim(),channelId:String(botRow.channel_id||c.channelId||'').trim()};
  if(!effective.token||!validId(effective.ownerId)||!validId(effective.channelId))throw Error('Complete Bot Connection for this bot first.');
  writeBotCfg(u,id,{...effective,owners:[effective.ownerId]});
  const verifyCfg=cfgForBot(u,id);
  const expectedOwner=String(effective.ownerId).trim();
  const ownerCandidates=[
    ...(Array.isArray(verifyCfg.owners)?verifyCfg.owners:[]),
    verifyCfg.ownerId, verifyCfg.owner_id,
    verifyCfg.discord?.ownerId, verifyCfg.discord?.owner_id
  ].map(v=>String(v??'').trim());
  if(!ownerCandidates.includes(expectedOwner)){
    const raw=fs.readFileSync(botCfgPath(u,id),'utf8');
    if(!raw.includes('\"ownerId\": '+JSON.stringify(expectedOwner)) && !raw.includes('\"ownerId\":\"'+expectedOwner+'\"')){
      throw Error('Owner ID could not be written to bot config.');
    }
  }
  const check=await validateToken(effective.token);if(!check.ok)throw Error(check.message);
  const rt=ensureBotRuntime(u,id);j={user:u.username,bot:rt.bot,botId:id,clients:new Set(),logs:j?.logs||[],child:null,state:'starting',startedAt:new Date().toISOString()};jobs.set(key(u,id),j);
  await dbPool.query("UPDATE tinshi_bots SET status='starting' WHERE id=? AND username=?",[id,u.username]);emit(j,`Discord bot verified: ${check.username}`);
  setupEnv(j);const py=path.join(j.bot,'.venv','bin','python');
  j.child=spawn(py,['-u','main.py'],{cwd:j.bot,env:{...process.env,PYTHONUNBUFFERED:'1',DISCORD_BOT_TOKEN:effective.token,DISCORD_OWNER_ID:String(effective.ownerId),BOT_OWNER_ID:String(effective.ownerId),OWNER_ID:String(effective.ownerId),DISCORD_CHANNEL_ID:String(effective.channelId)},stdio:['ignore','pipe','pipe']});
  j.child.stdout.on('data',d=>emit(j,d.toString(),'stdout'));j.child.stderr.on('data',d=>emit(j,d.toString(),'stderr'));
  j.child.on('spawn',async()=>{j.state='running';try{await dbPool.query("UPDATE tinshi_bots SET status='running' WHERE id=? AND username=?",[id,u.username])}catch{}emit(j,`Bot started. PID ${j.child.pid}`)});
  j.child.on('error',async e=>{j.state='error';try{await dbPool.query("UPDATE tinshi_bots SET status='error' WHERE id=? AND username=?",[id,u.username])}catch{}emit(j,e.message,'error')});
  j.child.on('exit',async(code,signal)=>{j.state='stopped';try{await dbPool.query("UPDATE tinshi_bots SET status='stopped' WHERE id=? AND username=?",[id,u.username])}catch{}emit(j,`Bot stopped. code=${code} signal=${signal||'none'}`,code===0?'system':'error');j.child=null});
  return {alreadyRunning:false};
}
app.post('/api/bot/start',premium,async(req,res)=>{try{const id=Number(req.body?.bot_id||0);if(!id)return res.status(400).json({error:'Bot ID is required.'});const u=req.currentUser;await startBotForUser(u,id);res.json({ok:true,botId:id});}catch(e){try{const u=await findUser(req.session.user.username);if(u)await dbPool.query("UPDATE tinshi_bots SET status='error' WHERE id=? AND username=?",[Number(req.body?.bot_id||0),u.username])}catch{}res.status(400).json({error:e.message})}});
app.post('/api/bot/stop',premium,async(req,res)=>{
  const id=Number(req.body?.bot_id||0);const j=job(req.session.user,id);if(!j||!alive(j))return res.status(409).json({error:'This bot is not running.'});
  j.state='stopping';emit(j,'Stopping bot...');try{await dbPool.query("UPDATE tinshi_bots SET status='stopping' WHERE id=? AND username=?",[id,req.session.user.username])}catch{}j.child.kill('SIGTERM');setTimeout(()=>{if(alive(j))j.child.kill('SIGKILL')},7000);res.json({ok:true});
});

function internal(req,res,next){if(!CONTROL_BOT_TOKEN)return res.status(503).json({error:'Control bot is not configured.'});if(String(req.get('x-control-secret')||'')!==CONTROL_BOT_SECRET)return res.status(403).json({error:'Forbidden'});next()}
app.get('/auth/discord',async(req,res)=>{try{const raw=String(req.query.token||'').trim();if(!raw||!dbPool)return res.status(401).send('Invalid login link.');const hash=crypto.createHash('sha256').update(raw).digest('hex');const [rows]=await dbPool.query('SELECT * FROM tinshi_users WHERE web_token_hash=? AND web_token_expires>NOW() LIMIT 1',[hash]);if(!rows[0])return res.status(401).send('Login link expired or already used.');const u=userFromRow(rows[0]);await dbPool.query('UPDATE tinshi_users SET web_token_hash=NULL,web_token_expires=NULL WHERE username=?',[u.username]);req.session.user={username:u.username,role:u.role};ensureRuntime(u);res.redirect('/bots.html');}catch(e){res.status(500).send('Login link unavailable.')}});
app.post('/api/internal/register',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim();if(!validId(did))return res.status(400).json({error:'Invalid Discord user ID.'});let u=await findUser('dc_'+did),created=false;if(!u){const temp=makeWebPassword();await dbPool.query('INSERT INTO tinshi_users (username,password_hash,is_admin,role,slot_count,discord_id) VALUES (?,?,?,?,?,?)',['dc_'+did,hashPassword(temp),0,'user',1,did]);u=await findUser('dc_'+did);created=true}else if(u.discordId!==did){await dbPool.query('UPDATE tinshi_users SET discord_id=? WHERE username=?',[did,u.username]);u=await findUser(u.username)}const login=await issueWebLogin(u);res.json({ok:true,user:{username:u.username,discordId:did},credentials:created?{username:u.username,password:null}:null,webUrl:login.url})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/internal/web-credentials',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim();if(!validId(did))return res.status(400).json({error:'Invalid Discord user ID.'});const u=await ensureDiscordAccount(did);const c=await resetWebCredentials(u);const base=`${req.protocol}://${req.get('host')}`;const login=await issueWebLogin(u,base);res.json({ok:true,username:c.username,password:c.password,webUrl:login.url,websiteUrl:base})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/internal/command-channel',internal,async(req,res)=>{try{const channelId=await getSetting('control_bot_commands_channel_id');res.json({ok:true,channelId})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/internal/command-channel',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim(),channelId=String(req.body?.channel_id||'').trim();if(did!==CONTROL_BOT_OWNER_ID)return res.status(403).json({error:'Owner only.'});if(!validId(channelId))return res.status(400).json({error:'Invalid Discord channel ID.'});await setSetting('control_bot_commands_channel_id',channelId);res.json({ok:true,channelId})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/internal/trial',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim();if(!validId(did))return res.status(400).json({error:'Invalid Discord user ID.'});const before=await findUser('dc_'+did);if(before?.trailUsed)return res.status(409).json({error:'Your 24-hour trial has already been used.'});if(before&&activeAccess(before))return res.status(409).json({error:'You already have active access.'});const u=await ensureTrialAccount(did);res.json({ok:true,username:u.username,premiumUntil:u.premiumUntil,slots:u.slotCount});}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/internal/manage-bots',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim(),name=String(req.body?.bot_name||'').trim(),token=String(req.body?.bot_token||'').trim(),ownerId=String(req.body?.owner_id||did).trim(),channelId=String(req.body?.channel_id||'').trim();if(!validId(did)||!name||!token||!validId(ownerId)||!validId(channelId))return res.status(400).json({error:'Bot name, Owner ID and Channel ID are required.'});let u=await findUser('dc_'+did);if(!u)u=await ensureDiscordAccount(did);if(!activeAccess(u))return res.status(402).json({error:'Activate your 24-hour trial with /trial or purchase a plan first.'});const [countRows]=await dbPool.query('SELECT COUNT(*) AS n FROM tinshi_bots WHERE username=?',[u.username]);const maxBots=Math.max(1,Number(u.slotCount||1));if(Number(countRows[0].n)>=maxBots)return res.status(409).json({error:`Your plan allows ${maxBots} bot slot(s).`});const check=await validateToken(token);if(!check.ok)return res.status(400).json({error:check.message});const [r]=await dbPool.query('INSERT INTO tinshi_bots (username,bot_name,bot_token,owner_id,channel_id) VALUES (?,?,?,?,?)',[u.username,name,token,ownerId,channelId]);writeBotCfg(u,r.insertId,{token,ownerId,channelId,owners:[ownerId]});ensureBotRuntime(u,r.insertId);await startBotForUser(u,r.insertId);res.json({ok:true,id:r.insertId,botName:name,configWritten:true,started:true});}catch(e){res.status(400).json({error:e.message})}});

app.post('/api/internal/payment-submit',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim(),txid=String(req.body?.txid||'').trim(),amount=Number(req.body?.amount||8);if(!validId(did))return res.status(400).json({error:'Invalid Discord user ID.'});if(!/^[A-Za-z0-9]{20,128}$/.test(txid))return res.status(400).json({error:'Enter a valid Litecoin transaction ID.'});if(![8,4].includes(amount))return res.status(400).json({error:'Amount must be $8 or $4.'});let u=await findUser('dc_'+did);if(!u)u=await ensureDiscordAccount(did);if(amount===4&&!hasPremium(u))return res.status(402).json({error:'Activate the $8 monthly plan first.'});if(amount===8&&hasPremium(u))return res.status(409).json({error:'Premium is already active.'});u.payment={status:'pending',txid,submittedAt:new Date().toISOString(),amountUsd:amount,network:'Litecoin',type:amount===8?'premium':'slot'};await saveUser(u);await dbPool.query('INSERT INTO tinshi_payments (username,plan,amount,method,txid,status,slots) VALUES (?,?,?,?,?,?,1)',[u.username,amount===8?'monthly':'extra_slot',amount,'LTC',txid,'pending']);res.json({ok:true,message:amount===8?'Monthly plan payment submitted for admin approval.':'Extra slot payment submitted for admin approval.'});}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/internal/bot-start',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim(),id=Number(req.body?.bot_id||0);const u=await findUser('dc_'+did);if(!validId(did)||!u)return res.status(404).json({error:'Account not found.'});if(!id)return res.status(400).json({error:'Bot ID is required.'});await startBotForUser(u,id);res.json({ok:true,botId:id});}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/internal/bot-stop',internal,async(req,res)=>{try{const did=String(req.body?.discord_id||'').trim(),id=Number(req.body?.bot_id||0);const u=await findUser('dc_'+did);if(!validId(did)||!u)return res.status(404).json({error:'Account not found.'});const j=job(u,id);if(!j||!alive(j))return res.status(409).json({error:'This bot is not running.'});j.state='stopping';emit(j,'Stopping bot...');await dbPool.query("UPDATE tinshi_bots SET status='stopping' WHERE id=? AND username=?",[id,u.username]);j.child.kill('SIGTERM');setTimeout(()=>{if(alive(j))j.child.kill('SIGKILL')},7000);res.json({ok:true});}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/internal/bot-status',internal,async(req,res)=>{try{const did=String(req.query.discord_id||'').trim(),id=Number(req.query.bot_id||0);const u=await findUser('dc_'+did);if(!validId(did)||!u)return res.status(404).json({error:'Account not found.'});const [rows]=await dbPool.query('SELECT id,bot_name,status,owner_id,channel_id FROM tinshi_bots WHERE id=? AND username=? LIMIT 1',[id,u.username]);if(!rows[0])return res.status(404).json({error:'Bot not found.'});const j=job(u,id);res.json({ok:true,bot:rows[0],state:alive(j)?'running':(j?.state||rows[0].status||'stopped'),pid:j?.child?.pid||null,uptime:j?.startedAt&&alive(j)?Date.now()-Date.parse(j.startedAt):0});}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/internal/payments',internal,async(req,res)=>{try{if(!dbPool)return res.status(503).json({error:'Database not connected'});const [rows]=await dbPool.query("SELECT username,txid,amount,created_at FROM tinshi_payments WHERE status='pending' ORDER BY id DESC");res.json({ok:true,pending:rows.map(r=>({username:r.username,txid:r.txid,amountUsd:Number(r.amount),createdAt:r.created_at,type:Number(r.amount)===8?'premium':'slot'}))});}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/internal/payment-approve',internal,async(req,res)=>{try{const username=String(req.body?.username||'').trim();const u=await findUser(username);if(!u)return res.status(404).json({error:'User not found.'});if(u.payment?.status!=='pending')return res.status(404).json({error:'Pending payment not found.'});const amount=Number(u.payment.amountUsd||8);if(amount===8){u.premiumUntil=new Date(Date.now()+PREMIUM_DAYS*86400000).toISOString();u.slotCount=Math.max(1,Number(u.slotCount||1));}else if(amount===4){u.slotCount=Math.max(1,Number(u.slotCount||1))+1;}u.payment.status='accepted';u.payment.acceptedAt=new Date().toISOString();await saveUser(u);await dbPool.query("UPDATE tinshi_payments SET status='approved',approved_at=NOW() WHERE username=? AND txid=?",[u.username,u.payment.txid]);res.json({ok:true,username:u.username,premiumUntil:u.premiumUntil||null,slotCount:u.slotCount||1});}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/internal/payment-reject',internal,async(req,res)=>{try{const username=String(req.body?.username||'').trim();const u=await findUser(username);if(!u||u.payment?.status!=='pending')return res.status(404).json({error:'Pending payment not found.'});u.payment.status='rejected';u.payment.rejectedAt=new Date().toISOString();await saveUser(u);await dbPool.query("UPDATE tinshi_payments SET status='rejected' WHERE username=? AND txid=?",[u.username,u.payment.txid]);res.json({ok:true});}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/internal/admin-link',internal,async(req,res)=>{try{const did=String(req.query.discord_id||'').trim();if(!validId(did)||did!==CONTROL_BOT_OWNER_ID)return res.status(403).json({error:'Owner only.'});const u=await findUser(ADMIN_USERNAME);if(!u||u.role!=='admin')return res.status(404).json({error:'Admin account not found.'});const login=await issueWebLogin(u);res.json({ok:true,webUrl:login.url});}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/internal/bots',internal,async(req,res)=>{try{const did=String(req.query.discord_id||'').trim();const u=await findUser('dc_'+did);if(!u)return res.json({ok:true,bots:[],webUrl:null});const [rows]=await dbPool.query('SELECT id,bot_name,status,owner_id,channel_id FROM tinshi_bots WHERE username=? ORDER BY id DESC',[u.username]);res.json({ok:true,bots:rows,premiumUntil:u.premiumUntil||null});}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/internal/bot-delete/:id',internal,async(req,res)=>{
  try{
    const did=String(req.body?.discord_id||'').trim(), id=Number(req.params.id||0);
    if(!validId(did)||!id)return res.status(400).json({error:'Discord ID and Bot ID are required.'});
    const u=await findUser('dc_'+did);
    if(!u)return res.status(404).json({error:'Account not found.'});
    const [rows]=await dbPool.query('SELECT id,bot_name FROM tinshi_bots WHERE id=? AND username=? LIMIT 1',[id,u.username]);
    if(!rows[0])return res.status(404).json({error:'Bot not found.'});
    const j=job(u,id);
    if(j && alive(j)){
      try{j.state='stopping'; j.child.kill('SIGTERM')}catch{}
      await new Promise(r=>setTimeout(r,500));
      if(j && alive(j)){try{j.child.kill('SIGKILL')}catch{}}
    }
    jobs.delete(key(u,id));
    await dbPool.query('DELETE FROM tinshi_bots WHERE id=? AND username=?',[id,u.username]);
    const dir=botDir(u,id);
    try{fs.rmSync(dir,{recursive:true,force:true})}catch(e){console.warn('[BOT DELETE] runtime cleanup:',e.message)}
    res.json({ok:true,message:`${rows[0].bot_name||'Bot'} was deleted successfully.`});
  }catch(e){res.status(400).json({error:e.message})}
});

app.get('/api/admin/payments',admin,async(req,res)=>{if(!dbPool)return res.status(503).json({error:'Database not connected'});const [rows]=await dbPool.query("SELECT username,txid,amount,created_at FROM tinshi_payments WHERE status='pending' ORDER BY id DESC");const pending=rows.map(r=>({username:r.username,txid:r.txid,submittedAt:r.created_at,amountUsd:Number(r.amount),network:'Litecoin',type:Number(r.amount)===8?'premium':'slot'}));res.json({ok:true,pending});});
app.post('/api/admin/payments/:username/accept',admin,async(req,res)=>{const u=await findUser(req.params.username);if(!u||u.payment?.status!=='pending')return res.status(404).json({error:'Pending payment not found.'});const amount=Number(u.payment.amountUsd||8);if(amount===8){u.premiumUntil=new Date(Date.now()+PREMIUM_DAYS*86400000).toISOString();u.slotCount=Math.max(1,Number(u.slotCount||1));}else if(amount===4){u.slotCount=Math.max(1,Number(u.slotCount||1))+1;}u.payment.status='accepted';u.payment.acceptedAt=new Date().toISOString();await saveUser(u);if(dbPool){await dbPool.query("UPDATE tinshi_payments SET status='approved',approved_at=NOW() WHERE username=? AND txid=?",[u.username,u.payment.txid]);}res.json({ok:true,premiumUntil:u.premiumUntil||null,slotCount:u.slotCount||1})});
app.post('/api/admin/payments/:username/reject',admin,async(req,res)=>{const u=await findUser(req.params.username);if(!u||u.payment?.status!=='pending')return res.status(404).json({error:'Pending payment not found.'});u.payment.status='rejected';u.payment.rejectedAt=new Date().toISOString();await saveUser(u);if(dbPool)await dbPool.query("UPDATE tinshi_payments SET status='rejected' WHERE username=? AND txid=?",[u.username,u.payment.txid]);res.json({ok:true})});
app.get('/api/admin/users',admin,async(req,res)=>{if(!dbPool)return res.status(503).json({error:'Database not connected'});const [rows]=await dbPool.query('SELECT username,role,premium_until,payment_json FROM tinshi_users ORDER BY id DESC');res.json({ok:true,users:rows.map(r=>{const u=userFromRow(r),j=job(u);return {username:u.username,role:u.role,premium:hasPremium(u),premiumUntil:premiumUntil(u)?.toISOString()||null,paymentStatus:u.payment?.status||'none',state:alive(j)?'running':(j?.state||'stopped')}})});});
app.use((req,res,next)=>{if(req.method==='GET'&&!req.path.startsWith('/api/'))return res.sendFile(path.join(ROOT,'public','index.html'));next()});

app.get('/api/bots', auth, async (req,res) => {
  if (!dbPool) return res.status(503).json({error:'Database not connected'});
  const u=await findUser(req.session.user.username);if(!hasPremium(u))return res.status(402).json({error:'Buy a plan first',code:'PLAN_REQUIRED'});
  const [rows]=await dbPool.query('SELECT id,bot_name,channel_id,status,created_at FROM tinshi_bots WHERE username=? ORDER BY id DESC',[u.username]);
  res.json({plan:{slots:Math.max(1,Number(u.slotCount||1)),premiumUntil:premiumUntil(u)?.toISOString()||null},bots:rows});
});
app.get('/api/bots/:id',premium,async(req,res)=>{
  const [rows]=await dbPool.query('SELECT id,bot_name,channel_id,status,created_at FROM tinshi_bots WHERE id=? AND username=? LIMIT 1',[Number(req.params.id),req.session.user.username]);
  if(!rows[0])return res.status(404).json({error:'Bot not found.'});
  const c=cfgForBot(req.session.user,Number(req.params.id));
  res.json({ok:true,bot:rows[0],connection:{token_set:!!c.token,channel_id:c.channelId||rows[0].channel_id||''}});
});
app.post('/api/bots', auth, async (req,res) => {
  if (!dbPool) return res.status(503).json({error:'Database not connected'});
  const u=await findUser(req.session.user.username);if(!hasPremium(u))return res.status(402).json({error:'Buy a plan first',code:'PLAN_REQUIRED'});
  const botName=String(req.body.bot_name||'').trim(),token=String(req.body.bot_token||'').trim(),ownerId=String(req.body.owner_id||u.discordId||'').trim(),channelId=String(req.body.channel_id||'').trim();
  if(!botName||!token||!ownerId||!channelId)return res.status(400).json({error:'Bot name, token and Channel ID are required.'});
  if(!validId(ownerId)||!validId(channelId))return res.status(400).json({error:'Owner ID and Channel ID must be valid Discord IDs.'});
  const check=await validateToken(token);
  if(!check.ok)return res.status(400).json({error:check.message});
  const [countRows]=await dbPool.query('SELECT COUNT(*) AS n FROM tinshi_bots WHERE username=?',[u.username]);const maxBots=Math.max(1,Number(u.slotCount||1));
  if(Number(countRows[0].n)>=maxBots)return res.status(409).json({error:`Your plan allows ${maxBots} bot slot(s)`});
  const [r]=await dbPool.query('INSERT INTO tinshi_bots (username,bot_name,bot_token,owner_id,channel_id) VALUES (?,?,?,?,?)',[u.username,botName,token,ownerId,channelId]);
  writeBotCfg(u,r.insertId,{token,ownerId,channelId,owners:[ownerId]});
  ensureBotRuntime(u,r.insertId);
  res.json({ok:true,id:r.insertId,redirect:`/console.html?id=${r.insertId}`});
});
app.post('/api/bots/:id/connection',premium,async(req,res)=>{
  const id=Number(req.params.id),u=await findUser(req.session.user.username);
  const token=String(req.body?.bot_token||'').trim(),ownerId=String(req.body?.owner_id||u.discordId||'').trim(),channelId=String(req.body?.channel_id||'').trim();
  if(!token||!validId(ownerId)||!validId(channelId))return res.status(400).json({error:'Bot token and Channel ID are required.'});
  const [rows]=await dbPool.query('SELECT id FROM tinshi_bots WHERE id=? AND username=? LIMIT 1',[id,u.username]);if(!rows[0])return res.status(404).json({error:'Bot not found.'});
  const j=job(req.session.user,id);if(alive(j))return res.status(409).json({error:'Stop this bot before changing its connection.'});
  const check=await validateToken(token);if(!check.ok)return res.status(400).json({error:check.message});
  await dbPool.query('UPDATE tinshi_bots SET bot_token=?,owner_id=?,channel_id=? WHERE id=? AND username=?',[token,ownerId,channelId,id,u.username]);
  writeBotCfg(u,id,{token,ownerId,channelId,owners:[ownerId]});res.json({ok:true,botId:id});
});
app.delete('/api/bots/:id', auth, async (req,res) => {
  if(!dbPool)return res.status(503).json({error:'Database not connected'});
  const id=Number(req.params.id),j=job(req.session.user,id);if(alive(j)){try{j.child.kill('SIGTERM')}catch{}}
  const [r]=await dbPool.query('DELETE FROM tinshi_bots WHERE id=? AND username=?',[id,req.session.user.username]);res.json({ok:r.affectedRows>0});
});
async function startControlBot(){
  if(!CONTROL_BOT_TOKEN){console.log('[CONTROL BOT] CONTROL_BOT_TOKEN not set — skipped.');return;}
  try{
    const entry=path.join(ROOT,'dc-bot','bot.py');
    const reqFile=path.join(ROOT,'dc-bot','requirements.txt');
    if(!fs.existsSync(entry))throw Error('dc-bot/bot.py not found.');
    const v=path.join(ROOT,'.control-venv');
    const py=path.join(v,'bin','python');
    if(!fs.existsSync(py)){
      const r=spawnSync('python3',['-m','venv',v],{cwd:ROOT,encoding:'utf8'});
      if(r.status!==0)throw Error(String(r.stderr||r.stdout||'python3-venv is required.').trim().slice(-1200));
    }
    const r=spawnSync(py,['-m','pip','install','--disable-pip-version-check','-q','-r',reqFile],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(r.status!==0)throw Error(String(r.stderr||r.stdout||'pip install failed').trim().slice(-1200));
    const child=spawn(py,['-u',entry],{cwd:ROOT,env:{...process.env,CONTROL_BOT_TOKEN,CONTROL_BOT_OWNER_ID,CONTROL_BOT_SECRET,CONTROL_BOT_API:BACKEND_URL||`http://127.0.0.1:${PORT}`,PYTHONUNBUFFERED:'1'},stdio:['ignore','inherit','inherit']});
    child.on('error',e=>console.error('[CONTROL BOT] process error:',e.message));
    child.on('exit',(c,s)=>{console.log(`[CONTROL BOT] stopped code=${c} signal=${s||'none'}`);if(c!==0)setTimeout(()=>startControlBot(),5000);});
    console.log('[CONTROL BOT] started automatically from dc-bot/bot.py');
  }catch(e){console.error('[CONTROL BOT] failed:',e.message);setTimeout(()=>startControlBot(),5000);}
}

const httpServer=app.listen(PORT, '0.0.0.0', () => {
  console.log(`TINSHI BOT PANEL running on http://0.0.0.0:${PORT}`);
});

(async()=>{
  await initDatabase();
  console.log(dbState.connected ? '[DB] Railway/MySQL: CONNECTED' : `[DB] Railway/MySQL: NOT CONNECTED — ${dbState.error || 'unknown error'}`);
  if(String(process.env.AUTO_START_CONTROL_BOT || 'true').toLowerCase()==='true') {
    setTimeout(()=>startControlBot(), 250);
  }
})().catch(e=>console.error('[BOOT] initialization error:', e.message));


app.get('/api/db-status', auth, async (req,res) => {
  if (!dbPool) return res.status(503).json({ok:false, connected:false, error:dbState.error || 'Database not connected'});
  try {
    await dbPool.query('SELECT 1');
    res.json({ok:true, connected:true, host:dbState.host, database:dbState.database});
  } catch(e) {
    res.status(503).json({ok:false, connected:false, error:e.message});
  }
});
