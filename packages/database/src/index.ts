import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// TransactionSql in postgres 3.4.8 omits its callable overloads. Keep the
// runtime tagged-template contract explicit, with no untyped query parameters.
export interface Query {
  <T extends readonly (object | undefined)[] = postgres.Row[]>(
    template: TemplateStringsArray,
    ...values: readonly postgres.ParameterOrFragment<never>[]
  ): postgres.PendingQuery<T>;
  unsafe: postgres.Sql["unsafe"];
  json: postgres.Sql["json"];
}
export type Database = Query &
  Pick<postgres.Sql, "end"> & {
    begin<T>(fn: (tx: Query) => Promise<T>): Promise<T>;
  };
export function connect(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error("DATABASE_URL required");
  return postgres(url, { max: 10, onnotice: () => {} }) as unknown as Database;
}
export const orm = (sql: postgres.Sql) => drizzle(sql);
