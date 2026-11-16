// Guardia contro il ritorno dei database creati per run.
//
// Il setup usa un unico database di test (DATABASE_URL_TEST) e ne svuota le
// tabelle: nessun database viene creato, quindi `realindi_test_run_*` non deve
// più comparire sul server. Se qualcuno reintroducesse la creazione per run,
// questa prova fallisce subito invece di lasciare che l'account Prisma accumuli
// database fino a bloccarsi di nuovo con `planLimitReached`.
//
// Il caso delle due run contemporanee sullo stesso database non è coperto da un
// meccanismo: è documentato in vitest.config.ts e si manifesta con errori
// rumorosi (sessioni sparite, foreign key violate), non silenziosi.
import { describe, expect, it } from "vitest";
import { sql } from "./helpers.js";

describe("igiene dei database di test", () => {
  it("nessun database realindi_test_run_ sul server", async () => {
    const righe: { datname: string }[] = await sql(
      "SELECT datname FROM pg_database WHERE datname LIKE 'realindi_test_run_%'",
    );
    expect(righe, "residui delle vecchie run: esegui `npm run db:pulisci-test`").toHaveLength(0);
  });
});
