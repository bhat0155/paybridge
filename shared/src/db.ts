import sql from "mssql";

const baseConfig = {
  server: process.env.SQL_HOST ?? "localhost",
  port: Number(process.env.SQL_PORT ?? 1433),
  user: process.env.SQL_USER ?? "sa",
  password: process.env.SQL_SA_PASSWORD,
  options: { trustServerCertificate: true, enableArithAbort: true },
};

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    pool = await new sql.ConnectionPool({ ...baseConfig, database: "paybridge" }).connect();
  }
  return pool;
}

export async function ensureSchema(): Promise<void> {
  const master = await new sql.ConnectionPool({ ...baseConfig, database: "master" }).connect();
  await master.request().query(`IF DB_ID('paybridge') IS NULL CREATE DATABASE paybridge;`);
  await master.close();

  const db = await getPool();
  await db.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'payments')
    CREATE TABLE payments (
      record_id UNIQUEIDENTIFIER PRIMARY KEY,
      source NVARCHAR(10) NOT NULL,
      source_event_id NVARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      currency NVARCHAR(3) NOT NULL,
      customer_name NVARCHAR(255) NOT NULL,
      description NVARCHAR(500) NOT NULL,
      status NVARCHAR(50) NOT NULL,
      event_timestamp DATETIME2 NOT NULL,
      CONSTRAINT UQ_payments_source_event UNIQUE (source, source_event_id)
    );
  `);
}
