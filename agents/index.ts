/**
 * @sentra/agents
 *
 * The triage, root-cause and fix-suggestion agents, the orchestrator that turns
 * analysis.json into report.md, and the one model client they all go through.
 *
 * The agents themselves land later in M3; the client and its transport port are
 * the parts that exist.
 */

export * from './transport.js'
export * from './model-client.js'
export * from './cassettes.js'
