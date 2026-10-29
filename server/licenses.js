const columns = `id,product_name AS "productName",product_description AS description,email,vendor,
  expiry_date AS "expiryDate",renewal_date AS "renewalDate",ip,status,
  created_at AS "createdAt",updated_at AS "updatedAt",
  CASE WHEN status='Suspended' THEN 'Suspended'
       WHEN expiry_date < CURRENT_DATE THEN 'Expired'
       WHEN renewal_date <= CURRENT_DATE THEN 'Renewal due'
       WHEN expiry_date <= CURRENT_DATE + 30 THEN 'Expiring soon'
       ELSE 'Active' END AS "computedStatus",
  GREATEST(0,expiry_date-CURRENT_DATE)::int AS "daysToExpiry"`;

export class LicenseStore {
  constructor(pool) { this.pool = pool; }
  async list(userId,{ search = '', status = '' } = {}) {
    const { rows } = await this.pool.query(`SELECT ${columns} FROM license_entries
      WHERE user_id=$1 AND ($2='' OR product_name ILIKE '%'||$2||'%' OR vendor ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%' OR ip ILIKE '%'||$2||'%')
      AND ($3='' OR CASE WHEN status='Suspended' THEN 'Suspended' WHEN expiry_date < CURRENT_DATE THEN 'Expired' WHEN renewal_date <= CURRENT_DATE THEN 'Renewal due' WHEN expiry_date <= CURRENT_DATE + 30 THEN 'Expiring soon' ELSE 'Active' END=$3)
      ORDER BY expiry_date ASC,lower(product_name)`,[userId,search,status]);
    return rows;
  }
  async dashboard(userId) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status<>'Suspended' AND expiry_date >= CURRENT_DATE)::int AS valid,
      count(*) FILTER (WHERE status<>'Suspended' AND expiry_date < CURRENT_DATE)::int AS expired,
      count(*) FILTER (WHERE status<>'Suspended' AND renewal_date > CURRENT_DATE AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30)::int AS expiring,
      count(*) FILTER (WHERE status<>'Suspended' AND renewal_date <= CURRENT_DATE AND expiry_date >= CURRENT_DATE)::int AS renewal_due
      FROM license_entries WHERE user_id=$1`,[userId]);
    const licenses = await this.list(userId);
    const soon = licenses.filter(item => item.computedStatus === 'Expiring soon' || item.computedStatus === 'Renewal due').slice(0,5);
    const vendors = await this.pool.query(`SELECT vendor,count(*)::int AS count FROM license_entries WHERE user_id=$1 GROUP BY vendor ORDER BY count DESC,lower(vendor) LIMIT 5`,[userId]);
    return { summary: rows[0], licenses, upcoming: soon, vendors: vendors.rows };
  }
  async get(userId,id) {
    const { rows } = await this.pool.query(`SELECT ${columns} FROM license_entries WHERE user_id=$1 AND id=$2`,[userId,id]);
    return rows[0] || null;
  }
  async create(userId,input) {
    const { rows } = await this.pool.query(`INSERT INTO license_entries(user_id,product_name,product_description,email,vendor,expiry_date,renewal_date,ip,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[userId,input.productName,input.description || null,input.email,input.vendor,input.expiryDate,input.renewalDate,input.ip,input.status || 'Active']);
    return this.get(userId,rows[0].id);
  }
  async update(userId,id,input) {
    const result = await this.pool.query(`UPDATE license_entries SET product_name=$3,product_description=$4,email=$5,vendor=$6,
      expiry_date=$7,renewal_date=$8,ip=$9,status=$10,updated_at=now() WHERE user_id=$1 AND id=$2`,[userId,id,input.productName,input.description || null,input.email,input.vendor,input.expiryDate,input.renewalDate,input.ip,input.status || 'Active']);
    return result.rowCount ? this.get(userId,id) : null;
  }
  async remove(userId,id) {
    const result = await this.pool.query('DELETE FROM license_entries WHERE user_id=$1 AND id=$2',[userId,id]);
    return result.rowCount > 0;
  }

  async createUser({name,email,passwordHash}) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const {rows}=await client.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,created_at AS "createdAt"',[name,email,passwordHash]);
      const user=rows[0];
      await client.query('UPDATE license_entries SET user_id=$1 WHERE user_id IS NULL',[user.id]);
      await client.query('COMMIT');
      return user;
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async findUserByEmail(email) {
    const {rows}=await this.pool.query('SELECT id,name,email,password_hash AS "passwordHash",email_verified_at AS "emailVerifiedAt" FROM users WHERE email=$1',[email]);
    return rows[0]||null;
  }
  async getUser(id) {
    const {rows}=await this.pool.query('SELECT id,name,email,email_verified_at AS "emailVerifiedAt" FROM users WHERE id=$1',[id]);
    return rows[0]||null;
  }
  async getUserForPassword(id) {
    const {rows}=await this.pool.query('SELECT id,name,email,password_hash AS "passwordHash" FROM users WHERE id=$1',[id]);
    return rows[0]||null;
  }
  async updateProfile(id,{name,email}) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current=await client.query('SELECT email FROM users WHERE id=$1 FOR UPDATE',[id]);
      if(!current.rowCount){await client.query('ROLLBACK');return null;}
      const emailChanged=current.rows[0].email!==email;
      const {rows}=await client.query(`UPDATE users SET name=$2,email=$3,email_verified_at=CASE WHEN $4 THEN NULL ELSE email_verified_at END
        WHERE id=$1 RETURNING id,name,email,email_verified_at AS "emailVerifiedAt"`,[id,name,email,emailChanged]);
      if(emailChanged){
        await client.query("DELETE FROM auth_tokens WHERE user_id=$1 AND purpose='verify_email'",[id]);
        await client.query("DELETE FROM sessions WHERE sess->>'userId'=$1",[id]);
      }
      await client.query('COMMIT');
      return {...rows[0],emailChanged};
    } catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
  async updatePassword(id,passwordHash,currentSessionId) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result=await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[id,passwordHash]);
      if(result.rowCount) await client.query("DELETE FROM sessions WHERE sess->>'userId'=$1 AND sid<>$2",[id,currentSessionId||'']);
      await client.query('COMMIT');
      return result.rowCount>0;
    } catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
  async createAuthToken(userId,purpose,tokenHash,expiresAt) {
    await this.pool.query('DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2',[userId,purpose]);
    await this.pool.query('INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,$4)',[tokenHash,userId,purpose,expiresAt]);
  }
  async consumeVerificationToken(tokenHash) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const token=await client.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose='verify_email' AND used_at IS NULL AND expires_at>now() FOR UPDATE",[tokenHash]);
      if(!token.rowCount){await client.query('ROLLBACK');return null;}
      const userId=token.rows[0].user_id;
      const {rows}=await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1 RETURNING id,name,email,email_verified_at AS "emailVerifiedAt"',[userId]);
      await client.query("UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='verify_email' AND used_at IS NULL",[userId]);
      await client.query('COMMIT');
      return rows[0]||null;
    } catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
  async consumePasswordResetToken(tokenHash,passwordHash) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const token=await client.query("SELECT user_id FROM auth_tokens WHERE token_hash=$1 AND purpose='password_reset' AND used_at IS NULL AND expires_at>now() FOR UPDATE",[tokenHash]);
      if(!token.rowCount){await client.query('ROLLBACK');return false;}
      const userId=token.rows[0].user_id;
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[userId,passwordHash]);
      await client.query("UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='password_reset' AND used_at IS NULL",[userId]);
      await client.query("DELETE FROM sessions WHERE sess->>'userId'=$1",[userId]);
      await client.query('COMMIT');
      return true;
    } catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
  async consumeRateLimit(key,limit,windowSeconds) {
    const {rows}=await this.pool.query(`INSERT INTO auth_rate_limits(key,window_started_at,hits) VALUES($1,now(),1)
      ON CONFLICT(key) DO UPDATE SET
        hits=CASE WHEN auth_rate_limits.window_started_at+($2*interval '1 second')<=now() THEN 1 ELSE auth_rate_limits.hits+1 END,
        window_started_at=CASE WHEN auth_rate_limits.window_started_at+($2*interval '1 second')<=now() THEN now() ELSE auth_rate_limits.window_started_at END
      RETURNING hits,GREATEST(1,ceil(extract(epoch FROM (window_started_at+($2*interval '1 second')-now()))))::int AS "retryAfter"`,[key,windowSeconds]);
    const result={allowed:rows[0].hits<=limit,retryAfter:rows[0].retryAfter};
    if(Math.random()<.01)this.pool.query("DELETE FROM auth_rate_limits WHERE window_started_at<now()-interval '2 days'").catch(()=>{});
    return result;
  }
}
