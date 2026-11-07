// Applica le migrazioni versionate di prisma/migrations al database indicato
// da DATABASE_URL. Sostituisce `prisma db push`: lo schema non viene più
// forzato sul database, si applicano soltanto i passi registrati in
// _prisma_migrations, nell'ordine in cui sono stati scritti.
//
// Un database creato prima delle migrazioni — la produzione, dove le tabelle le
// ha sempre create db push — non è "vuoto" per Migrate, che si ferma con P3005.
// In quel caso la migrazione iniziale descrive uno stato che il database ha
// già: va marcata come applicata, non eseguita. Non lo si fa alla cieca, però:
// prima si controlla che tutte le tabelle dello schema esistano davvero,
// altrimenti su un database indietro di qualche versione il baseline
// nasconderebbe le differenze invece di applicarle.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const MIGRATIONS = resolve(process.cwd(), "prisma/migrations");

function prisma(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("npx", ["prisma", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${stdout ?? ""}${stderr ?? ""}` };
  }
}

/** Tabelle dichiarate nello schema, con il nome reale preso da @@map. */
function schemaTables(): string[] {
  const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
  return [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((match) => match[1]);
}

async function existingTables(url: string): Promise<Set<string>> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return new Set(result.rows.map((row) => row.table_name));
  } finally {
    await client.end();
  }
}

/** La migrazione iniziale: quella che descrive il database preesistente. */
function firstMigration(): string {
  const name = readdirSync(MIGRATIONS)
    .filter((entry) => entry !== "migration_lock.toml")
    .sort()[0];
  if (!name) throw new Error("Nessuna migrazione in prisma/migrations.");
  return name;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL non impostata.");

  const deploy = prisma(["migrate", "deploy"]);
  if (deploy.ok) {
    process.stdout.write(deploy.output);
    return;
  }

  // Solo un database preesistente merita il baseline: connessione rifiutata o
  // migrazione rotta sono problemi veri e vanno mostrati così come sono.
  if (!/P3005|schema is not empty/.test(deploy.output)) {
    process.stderr.write(deploy.output);
    process.exit(1);
  }

  const existing = await existingTables(url);
  const missing = schemaTables().filter((table) => !existing.has(table));
  if (missing.length > 0) {
    process.stderr.write(
      `Il database non ha tutte le tabelle dello schema (${missing.join(", ")}): ` +
        "non è lo stato descritto dalla migrazione iniziale, quindi non viene marcata come applicata.\n" +
        "Allinea lo schema a mano e ricommitta la migrazione prima di rieseguire.\n",
    );
    process.exit(1);
  }

  const init = firstMigration();
  const resolved = prisma(["migrate", "resolve", "--applied", init]);
  if (!resolved.ok) {
    process.stderr.write(resolved.output);
    process.exit(1);
  }
  process.stdout.write(resolved.output);
  console.log(`Database preesistente: ${init} marcata come già applicata.`);

  const retry = prisma(["migrate", "deploy"]);
  if (!retry.ok) {
    process.stderr.write(retry.output);
    process.exit(1);
  }
  process.stdout.write(retry.output);
}

await main();
