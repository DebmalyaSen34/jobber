import { randomUUID } from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";

export interface Persistence {
  connect(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

type RuntimeRecord = {
  _id: "api";
  boot_count: number;
  instance_id: string;
  release: string;
  started_at: Date;
  last_ready_at: Date;
};

export class MongoPersistence implements Persistence {
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly collection: Collection<RuntimeRecord>;
  private readonly instanceId = randomUUID();

  constructor(uri: string, databaseName: string, connectTimeoutMs: number, private readonly release: string) {
    this.client = new MongoClient(uri, {
      appName: "jobber-api",
      maxPoolSize: 10,
      serverSelectionTimeoutMS: connectTimeoutMs,
    });
    this.database = this.client.db(databaseName);
    this.collection = this.database.collection<RuntimeRecord>("service_runtime");
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.database.command({ ping: 1 });
    const now = new Date();
    await this.collection.updateOne(
      { _id: "api" },
      {
        $inc: { boot_count: 1 },
        $set: {
          instance_id: this.instanceId,
          release: this.release,
          started_at: now,
          last_ready_at: now,
        },
        $setOnInsert: { _id: "api" },
      },
      { upsert: true },
    );
  }

  async ping(): Promise<void> {
    await this.database.command({ ping: 1 });
    await this.collection.updateOne({ _id: "api" }, { $set: { last_ready_at: new Date() } });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
