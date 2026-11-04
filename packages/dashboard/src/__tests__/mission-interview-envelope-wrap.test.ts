// @vitest-environment node

/*
FNXC:InterviewEnvelopeNormalize 2026-11-04-09:34:
Mission-interview models intermittently drop the {type, data} envelope and answer with a bare
question object (SUBC incident 2026-11-03 18:06:52 CET journal: all four sessions across two
models died at "Invalid response structure"). The parser wraps the unambiguous bare shapes
instead of failing the session, keeps strict rejection for anything still ambiguous, and emits
the bounded `mission:interview-envelope-repaired` diagnostic counter (fixed reason enum, no
response content) so model discipline is measurable.
*/

import { describe, expect, it, afterEach } from "vitest";
import { parseMissionAgentResponse } from "../mission-interview.js";
import { resetDiagnosticsSink, setDiagnosticsSink, type LogEntry } from "../ai-session-diagnostics.js";

// Exact journal parsedSnippet from the incident: a bare question object with
// id/type/question/description and no {type, data} envelope.
const INCIDENT_BARE_QUESTION = {
  id: "q5-pilot-timing",
  type: "single_select",
  question: "When should the pilot cohort start?",
  description: "Pick the earliest workable window.",
};

const captured: LogEntry[] = [];

function repairCounters(): LogEntry[] {
  return captured.filter((entry) => entry.message === "mission:interview-envelope-repaired");
}

afterEach(() => {
  resetDiagnosticsSink();
  captured.length = 0;
});

describe("parseMissionAgentResponse envelope normalization", () => {
  it("parses the incident's bare question object by wrapping it (regression)", () => {
    setDiagnosticsSink((level, scope, message, context) => captured.push({ level, scope, message, context }));

    const parsed = parseMissionAgentResponse(JSON.stringify(INCIDENT_BARE_QUESTION));

    expect(parsed).toEqual({ type: "question", data: INCIDENT_BARE_QUESTION });
    expect(parsed.type === "question" && parsed.data.id).toBe("q5-pilot-timing");
    expect(repairCounters()).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "mission:interview-envelope-repaired",
        context: expect.objectContaining({ operation: "parse-validate", repair: "question" }),
      }),
    ]);
  });

  it("wraps a bare milestones payload as a complete response", () => {
    setDiagnosticsSink((level, scope, message, context) => captured.push({ level, scope, message, context }));
    const bare = {
      missionTitle: "Pilot rollout",
      milestones: [{ title: "M1", slices: [] }],
    };

    const parsed = parseMissionAgentResponse(JSON.stringify(bare));

    expect(parsed).toEqual({ type: "complete", data: bare });
    expect(repairCounters()).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ repair: "milestones" }),
      }),
    ]);
  });

  it("leaves proper question and complete envelopes untouched without emitting the counter", () => {
    setDiagnosticsSink((level, scope, message, context) => captured.push({ level, scope, message, context }));

    const questionEnvelope = {
      type: "question",
      data: { id: "q1", type: "text", question: "What is the goal?" },
    };
    expect(parseMissionAgentResponse(JSON.stringify(questionEnvelope))).toEqual(questionEnvelope);

    const completeEnvelope = {
      type: "complete",
      data: { missionTitle: "T", milestones: [{ title: "M1", slices: [] }] },
    };
    expect(parseMissionAgentResponse(JSON.stringify(completeEnvelope))).toEqual(completeEnvelope);

    expect(repairCounters()).toEqual([]);
  });

  it("keeps strict rejection for bare objects that stay ambiguous", () => {
    for (const junk of [
      JSON.stringify({ foo: 1 }),
      JSON.stringify({ id: "q1" }),
      JSON.stringify({ id: 42, question: "Q?" }),
      JSON.stringify({ type: "question", data: null }),
    ]) {
      expect(() => parseMissionAgentResponse(junk)).toThrow("AI returned an invalid response structure");
    }
    // Bracket-only input never produces a JSON candidate at the extractor layer.
    expect(() => parseMissionAgentResponse("[1,2]")).toThrow("AI returned no valid JSON");
    expect(() => parseMissionAgentResponse("no json here")).toThrow("AI returned no valid JSON");
    expect(repairCounters()).toEqual([]);
  });
});
