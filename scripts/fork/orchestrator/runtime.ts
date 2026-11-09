import { Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SingleRunner from "effect/cluster/SingleRunner"
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine"

/** One process owns this run-local database. It is never copied between workers. */
export const workflowRuntime = (filename: string) => ClusterWorkflowEngine.layer.pipe(
  Layer.provide(SingleRunner.layer({ runnerStorage: "memory" })),
  Layer.provide(SqliteClient.layer({ filename })),
  Layer.provide(BunServices.layer),
)
