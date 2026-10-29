import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import { createHash,randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool,migrate } from './db.js';
import { LicenseStore } from './licenses.js';
import { Mailer } from './mailer.js';
import { createAuthRouter,requireAuth } from './auth.js';

const secret=process.env.SESSION_SECRET;
if(!secret||secret.length<32)throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in .env.');
await migrate();
const app=express();
const store=new LicenseStore(pool);
const mailer=new Mailer();
const port=Number(process.env.PORT||3002);
const host=process.env.HOST||'127.0.0.1';
const dirname=path.dirname(fileURLToPath(import.meta.url));
app.disable('x-powered-by');
if(process.env.COOKIE_SECURE==='true')app.set('trust proxy',1);
app.use(cors({origin:process.env.CORS_ORIGIN||false,credentials:true}));
app.use(express.json({limit:'32kb'}));
const PgSession=connectPgSimple(session);
app.use(session({
  name:'licensedesk.sid',
  store:new PgSession({pool,createTableIfMissing:true,tableName:'sessions'}),
  secret,resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',maxAge:7*24*60*60*1000}
}));

app.use('/api/auth',createAuthRouter(store,mailer));
app.get('/api/health',async(_req,res,next)=>{try{await pool.query('SELECT 1');res.json({ok:true});}catch(error){next(error);}});
app.use('/api',requireAuth,(req,_res,next)=>{req.userId=req.session.userId;next();});

const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.get('/api/settings',async(req,res)=>{const user=await store.getUser(req.userId);if(!user)return res.status(404).json({error:'Account not found.'});res.json({profile:{id:user.id,name:user.name,email:user.email},emailDeliveryConfigured:mailer.configured});});
app.put('/api/settings/profile',async(req,res)=>{
  const name=typeof req.body?.name==='string'?req.body.name.trim():'';
  const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
  if(!name||name.length>80)return res.status(400).json({error:'Name is required and must be 80 characters or fewer.'});
  if(email.length>254||!emailPattern.test(email))return res.status(400).json({error:'Enter a valid email address.'});
  try{
    const current=await store.getUser(req.userId);if(!current)return res.status(404).json({error:'Account not found.'});
    if(current.email!==email&&!mailer.available)return res.status(503).json({error:'Configure SMTP before changing the account email.'});
    const profile=await store.updateProfile(req.userId,{name,email});
    if(profile.emailChanged){
      const token=randomBytes(32).toString('base64url');const tokenHash=createHash('sha256').update(token).digest('hex');
      await store.createAuthToken(req.userId,'verify_email',tokenHash,new Date(Date.now()+24*60*60*1000));
      let sent=true;try{await mailer.sendVerification(profile,token);}catch(error){sent=false;console.error('Email-change verification could not be delivered:',error);}
      await new Promise(resolve=>req.session.destroy(()=>resolve()));res.clearCookie('licensedesk.sid');
      return res.json({profile:{id:profile.id,name:profile.name,email:profile.email},emailVerificationRequired:true,message:sent?'Your email changed. Verify the new address using the message we sent, then sign in again.':'Your email changed, but verification email could not be delivered. Fix SMTP, then request another verification email.'});
    }
    res.json({profile:{id:profile.id,name:profile.name,email:profile.email}});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'That email is already in use.'});throw error;}
});
app.put('/api/settings/password',async(req,res)=>{
  const {currentPassword,newPassword}=req.body||{};
  if(typeof currentPassword!=='string'||!currentPassword||typeof newPassword!=='string'||newPassword.length<8||Buffer.byteLength(newPassword,'utf8')>72)return res.status(400).json({error:'Enter your current password and a new password of at least 8 characters (72 bytes maximum).'});
  const user=await store.getUserForPassword(req.userId);
  if(!user||!await bcrypt.compare(currentPassword,user.passwordHash))return res.status(400).json({error:'Current password is incorrect.'});
  await store.updatePassword(req.userId,await bcrypt.hash(newPassword,12),req.sessionID);res.json({ok:true});
});

app.get('/api/dashboard',async(req,res)=>res.json(await store.dashboard(req.userId)));
const validDate=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
};
const validateLicense=body=>{
  const input={
    productName:typeof body?.productName==='string'?body.productName.trim():'',
    description:typeof body?.description==='string'?body.description.trim():'',
    email:typeof body?.email==='string'?body.email.trim():'',
    vendor:typeof body?.vendor==='string'?body.vendor.trim():'',
    expiryDate:body?.expiryDate,renewalDate:body?.renewalDate,
    ip:typeof body?.ip==='string'?body.ip.trim():'',status:body?.status==='Suspended'?'Suspended':'Active'
  };
  if(!input.productName||input.productName.length>255)throw new Error('Product name is required (255 characters maximum).');
  if(!input.email||input.email.length>255||!emailPattern.test(input.email))throw new Error('Enter a valid contact email address.');
  if(!input.vendor||input.vendor.length>255)throw new Error('Vendor is required (255 characters maximum).');
  if(!input.ip||input.ip.length>255)throw new Error('IP address or device is required (255 characters maximum).');
  if(!validDate(input.expiryDate)||!validDate(input.renewalDate))throw new Error('Choose valid expiry and renewal dates.');
  if(input.description.length>10000)throw new Error('Description must be 10,000 characters or fewer.');
  return input;
};
app.get('/api/licenses',async(req,res)=>{
  const search=typeof req.query.search==='string'?req.query.search.trim().slice(0,100):'';
  const allowed=['Active','Expiring soon','Renewal due','Expired','Suspended'];
  const status=allowed.includes(req.query.status)?req.query.status:'';
  res.json(await store.list(req.userId,{search,status}));
});
app.post('/api/licenses',async(req,res)=>{try{res.status(201).json(await store.create(req.userId,validateLicense(req.body)));}catch(error){if(!error.code)return res.status(400).json({error:error.message});throw error;}});
app.put('/api/licenses/:id',async(req,res)=>{
  if(!/^\d+$/.test(req.params.id))return res.status(404).json({error:'License not found.'});
  try{const item=await store.update(req.userId,Number(req.params.id),validateLicense(req.body));if(!item)return res.status(404).json({error:'License not found.'});res.json(item);}
  catch(error){if(!error.code)return res.status(400).json({error:error.message});throw error;}
});
app.delete('/api/licenses/:id',async(req,res)=>{if(!/^\d+$/.test(req.params.id)||!await store.remove(req.userId,Number(req.params.id)))return res.status(404).json({error:'License not found.'});res.status(204).end();});

const dirname2=dirname;
const clientDist=path.resolve(dirname2,'../dist');
app.use(express.static(clientDist));
app.get('*splat',(req,res,next)=>{if(req.path.startsWith('/api/'))return next();res.sendFile(path.join(clientDist,'index.html'),error=>error&&next(error));});
app.use((error,_req,res,_next)=>{
  if(error?.type==='entity.too.large')return res.status(413).json({error:'Request body is too large.'});
  if(error instanceof SyntaxError&&'body'in error)return res.status(400).json({error:'Request body must contain valid JSON.'});
  console.error('LicenseDesk server error:',error);res.status(500).json({error:'Internal server error.'});
});
const server=app.listen(port,host,()=>console.log(`LicenseDesk backend listening on http://${host}:${port}`));
async function shutdown(){server.close(()=>pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);

