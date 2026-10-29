import nodemailer from 'nodemailer';

export class Mailer {
  #transport;
  #from;
  constructor(){
    this.#from=process.env.SMTP_FROM||process.env.SMTP_USER;
    if(process.env.SMTP_HOST&&this.#from)this.#transport=nodemailer.createTransport({
      host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',
      auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD||''}:undefined
    });
  }
  get configured(){return Boolean(this.#transport&&this.#from);}
  get available(){return this.configured||process.env.NODE_ENV!=='production';}
  async sendVerification(user,token){
    const link=accountLink('verify',token);
    if(!this.configured){if(process.env.NODE_ENV==='production')throw new Error('Email delivery is not configured.');console.info(`Development email verification link for ${user.email}: ${link}`);return {developmentLink:true};}
    await this.#transport.sendMail({from:this.#from,to:user.email,subject:'Verify your LicenseDesk email',
      text:`Hello ${user.name},\n\nVerify your email address to activate your LicenseDesk account:\n${link}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this message.`,
      html:`<p>Hello ${escapeHtml(user.name)},</p><p>Verify your email address to activate your LicenseDesk account:</p><p><a href="${escapeHtml(link)}">Verify email</a></p><p>This link expires in 24 hours. If you did not create this account, you can ignore this message.</p>`});
  }
  async sendPasswordReset(user,token){
    const link=accountLink('reset',token);
    if(!this.configured){if(process.env.NODE_ENV==='production')throw new Error('Email delivery is not configured.');console.info(`Development password reset link for ${user.email}: ${link}`);return {developmentLink:true};}
    await this.#transport.sendMail({from:this.#from,to:user.email,subject:'Reset your LicenseDesk password',
      text:`Hello ${user.name},\n\nUse this link to reset your LicenseDesk password:\n${link}\n\nThis link expires in 1 hour. If you did not request a reset, you can ignore this message.`,
      html:`<p>Hello ${escapeHtml(user.name)},</p><p>Use this link to reset your LicenseDesk password:</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>This link expires in 1 hour. If you did not request a reset, you can ignore this message.</p>`});
  }
}
function accountLink(key,token){const link=new URL(process.env.APP_BASE_URL||'http://localhost:5174');link.searchParams.set(key,token);return link.toString();}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
