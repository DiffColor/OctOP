import dns from "node:dns";
import { connect, StringCodec } from "nats";
import rethinkdbdash from "rethinkdbdash";

const NATS_URL = process.env.OCTOP_NATS_URL ?? "nats://nats.ilycode.app:4222";
const RDB_HOST = process.env.OCTOP_RETHINKDB_HOST ?? "rethinkdb.ilycode.app";
const RDB_PORT = Number(process.env.OCTOP_RETHINKDB_PORT ?? 28015);
const RDB_DB = process.env.OCTOP_RETHINKDB_DB ?? "OctOP";
const RDB_USER = process.env.OCTOP_RETHINKDB_USER ?? "";
const RDB_PASSWORD = process.env.OCTOP_RETHINKDB_PASSWORD ?? "";

const USER_TABLE = "bridge_user_state";
const THREAD_TABLE = "thread_projection";
const EVENT_TABLE = "event_log";

dns.setDefaultResultOrder("ipv4first");

const sc = StringCodec();
const nc = await connect({ servers: NATS_URL });
const r = rethinkdbdash({
  host: RDB_HOST,
  port: RDB_PORT,
  db: RDB_DB,
  user: RDB_USER,
  password: RDB_PASSWORD,
  silent: true
});

async function ensureStorage() {
  const dbs = await r.dbList().run();

  if (!dbs.includes(RDB_DB)) {
    await r.dbCreate(RDB_DB).run();
  }

  const tables = await r.db(RDB_DB).tableList().run();

  if (!tables.includes(USER_TABLE)) {
    await r.db(RDB_DB).tableCreate(USER_TABLE).run();
  }

  if (!tables.includes(THREAD_TABLE)) {
    await r.db(RDB_DB).tableCreate(THREAD_TABLE).run();
  }

  if (!tables.includes(EVENT_TABLE)) {
    await r.db(RDB_DB).tableCreate(EVENT_TABLE).run();
  }
}

function eventDocument(event) {
  return {
    id: `${event.user_id}-${event.timestamp}-${event.type}`.replace(/[^a-zA-Z0-9:_-]/g, "_"),
    ...event
  };
}

async function upsertUserState(event) {
  const current =
    (await r.db(RDB_DB).table(USER_TABLE).get(event.user_id).run()) ??
    {
      id: event.user_id,
      projects: [],
      threads: [],
      last_event_type: "",
      updated_at: event.timestamp
    };

  const next = {
    ...current,
    last_event_type: event.type,
    updated_at: event.timestamp
  };

  if (event.type === "bridge.status.updated") {
    next.status = event.payload;
  }

  if (event.type === "bridge.projects.updated") {
    next.projects = event.payload.projects ?? [];
  }

  if (event.type === "bridge.threads.updated") {
    next.threads = event.payload.threads ?? [];
  }

  await r.db(RDB_DB).table(USER_TABLE).insert(next, { conflict: "replace" }).run();
}

async function upsertThreadProjection(event) {
  const thread = event.payload?.thread;

  if (!thread?.id) {
    return;
  }

  const next = {
    ...thread,
    user_id: event.user_id,
    last_event_type: event.type,
    projected_at: event.timestamp
  };

  await r.db(RDB_DB).table(THREAD_TABLE).insert(next, { conflict: "update" }).run();
}

async function persistEvent(event) {
  await r.db(RDB_DB).table(EVENT_TABLE).insert(eventDocument(event), { conflict: "replace" }).run();
}

await ensureStorage();

const subscription = nc.subscribe("octop.user.*.events");

console.log(
  `OctOP projection worker connected to NATS ${NATS_URL} and RethinkDB ${RDB_HOST}:${RDB_PORT}/${RDB_DB}`
);

for await (const message of subscription) {
  const event = JSON.parse(sc.decode(message.data));
  await persistEvent(event);
  await upsertUserState(event);
  await upsertThreadProjection(event);
}
