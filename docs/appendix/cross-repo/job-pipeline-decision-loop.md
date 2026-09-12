# Job pipeline decision loop

Goal: a decision consumer turns job pipeline changes into accountable decisions that reach its operator; its runtime tracks open work, responsibility, and subsequent outcomes.

| Boundary | Owner | Dependency / evidence |
|---|---|---|
| Submitted applications and stage/follow-up state | resume-agent private MCP and its Supabase tables | job-hunt-agent/src/ob1.ts writes log_application/update_stage; unrelated OB1 extension schema is not this data model |
| Summary, changes, due work | resume-agent, this feature | Database-backed feed, complete totals, replayable changes, explicit baseline and failure |
| Classification, intake, checkpoint acknowledgement, operator outcomes | External decision consumer | Shared bounded operations; consumer advances its checkpoint only after durable processing, never merely after fetching |
| Work lifecycle and derived queue | External decision runtime | Registered real subjects, scoped grants, server-derived projection and outcome transitions |
| Brief delivery | External delivery consumer | Consume shared queue after healthy-path adoption |
| Read-only credentials | resume-agent#247 | Remains open; private authenticated MCP is currently broader than a read-only credential |

Other source integrations retain ownership of their classification and routing. This source feature does not create another queue or response handler. Activation requires the shared implementations and their concrete versioned contracts, not issue status alone.

Thesis acceptance: one real due follow-up yields one Runtime work item; a delivered brief references it; the operator records a disposition; action evidence or a dated deferral is read back; rerunning creates no duplicate. Record source cursor, work ID, projection sequence, delivery receipt, disposition, run terminal status, and next-run state. Approval is not execution. Source tests alone cannot pass this acceptance gate.

Known deficiencies carried: unlogged submissions remain unknown; recorded application totals do not prove real-world submission completeness; historical staging logs may be contaminated; conversion quality/window definitions are deferred; contact notes and raw resumes are excluded. First baseline establishes observation without pretending historical rows are fresh changes.
