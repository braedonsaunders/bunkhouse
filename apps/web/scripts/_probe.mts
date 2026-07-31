import pg from 'pg'
const client = new pg.Client({ connectionString: process.env.BUNKHOUSE_DB_URL })
await client.connect()
await client.query('alter table departments no force row level security')
const r = await client.query(`INSERT INTO departments (tenant_id,name,slug,scene_kind,position)
  SELECT t.id, d.name, d.slug, d.kind, d.pos FROM tenants t CROSS JOIN (VALUES
    ('The floor','floor','office',0),('Executive','executive','executive',1),
    ('Warehouse','warehouse','warehouse',2),('Server room','server-room','serverroom',3),
    ('Break room','break-room','breakroom',4),('Rooftop','rooftop','rooftop',5)
  ) AS d(name,slug,kind,pos) ON CONFLICT (tenant_id,slug) DO NOTHING`)
await client.query('alter table departments force row level security')
console.log('reseeded rows:', r.rowCount)
await client.end()

const { listDepartments } = await import('../src/lib/departments')
const { db } = await import('../src/db/client')
const app = db()
const [t] = (await app.withSuperAdmin((s) => s.execute('select id from tenants limit 1'))).rows as { id: string }[]
const list = await listDepartments(t!.id)
console.log('listDepartments through the app:', list.length, JSON.stringify(list.map((d) => d.name)))
process.exit(0)
