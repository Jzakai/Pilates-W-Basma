// Where receipt files are kept.
//
// With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, receipts go to a private Supabase Storage
// bucket (so they survive restarts on hosts without a persistent disk). Otherwise they are saved
// in a local folder, which is fine for development.

const fs = require('node:fs');
const path = require('node:path');

function localStorage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, path.basename(key));
  return {
    kind: 'local',
    async init() {},
    async save(key, buffer) {
      await fs.promises.writeFile(file(key), buffer);
    },
    async read(key) {
      try {
        return await fs.promises.readFile(file(key));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(key) {
      await fs.promises.rm(file(key), { force: true });
    },
  };
}

function supabaseStorage({ url, serviceKey, bucket, fetchImpl = fetch }) {
  const base = `${url.replace(/\/$/, '')}/storage/v1`;
  const headers = (extra = {}) => ({ Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, ...extra });
  const objectUrl = (key) => `${base}/object/${encodeURIComponent(bucket)}/${encodeURIComponent(path.basename(key))}`;

  async function fail(res, what) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase Storage ${what} failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return {
    kind: 'supabase',
    // Creates the private bucket on first start. "Already exists" is fine.
    async init() {
      const res = await fetchImpl(`${base}/bucket`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: bucket, name: bucket, public: false }),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      if (res.status === 409 || /already exists|Duplicate/i.test(body)) return;
      throw new Error(`Supabase Storage bucket setup failed (${res.status}): ${body.slice(0, 200)}`);
    },
    async save(key, buffer, contentType) {
      const res = await fetchImpl(objectUrl(key), {
        method: 'POST',
        headers: headers({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'false' }),
        body: buffer,
      });
      if (!res.ok) await fail(res, 'upload');
    },
    async read(key) {
      const res = await fetchImpl(objectUrl(key), { headers: headers() });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) await fail(res, 'download');
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(key) {
      const res = await fetchImpl(`${base}/object/${encodeURIComponent(bucket)}`, {
        method: 'DELETE',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: [path.basename(key)] }),
      });
      if (!res.ok) await fail(res, 'delete');
    },
  };
}

function createStorage(config, options = {}) {
  if (config.supabaseUrl && config.supabaseServiceKey) {
    return supabaseStorage({
      url: config.supabaseUrl,
      serviceKey: config.supabaseServiceKey,
      bucket: config.supabaseBucket,
      ...options,
    });
  }
  return localStorage(config.uploadDir);
}

module.exports = { createStorage, localStorage, supabaseStorage };
