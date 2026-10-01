import { describe, it, expect } from "vitest";
import { parseSegments } from "../../../plugins/protocol-gate/segments.js";

// Shell segment splitter for denial attribution: compound commands break
// into ordered segments on conjunctions, chains, and pipes so feedback can
// name the exact failing piece. The pre-existing stage guard only knew the
// conjunction and chain forms, so the pipe cases below pin the gap it left.

describe("shell segment splitting", () => {
  it("splits a two-part pipeline into its stages", () => {
    expect(parseSegments("cat notes.txt | grep error")).toEqual([
      "cat notes.txt",
      "grep error",
    ]);
  });

  it("splits a pipeline chained after a conjunction", () => {
    expect(parseSegments("make test && cat out.log | grep FAIL")).toEqual([
      "make test",
      "cat out.log",
      "grep FAIL",
    ]);
  });

  it("splits an alternation chained after a semicolon", () => {
    expect(parseSegments("git status; git branch || git log")).toEqual([
      "git status",
      "git branch",
      "git log",
    ]);
  });

  it("keeps the classic conjunction and chain forms splitting", () => {
    expect(parseSegments("git status && git diff")).toEqual([
      "git status",
      "git diff",
    ]);
    expect(parseSegments("git status; git branch")).toEqual([
      "git status",
      "git branch",
    ]);
    expect(parseSegments("make test || make build")).toEqual([
      "make test",
      "make build",
    ]);
  });

  it("returns a lone command as its own segment", () => {
    expect(parseSegments("make lint")).toEqual(["make lint"]);
  });

  it("trims surrounding whitespace from each segment", () => {
    expect(parseSegments("  make test   &&   make build  ")).toEqual([
      "make test",
      "make build",
    ]);
  });
});

describe("shell segment quoting and chains", () => {
  it("leaves a double-quoted pipe inside its segment", () => {
    expect(parseSegments('grep "a|b" notes.txt')).toEqual([
      'grep "a|b" notes.txt',
    ]);
  });

  it("leaves single-quoted and backtick-quoted separators inside their segment", () => {
    expect(parseSegments("grep 'a && b' notes.txt | head")).toEqual([
      "grep 'a && b' notes.txt",
      "head",
    ]);
    expect(parseSegments("echo `date | head` && make test")).toEqual([
      "echo `date | head`",
      "make test",
    ]);
  });

  it("leaves an escaped separator outside quotes inside its segment", () => {
    expect(parseSegments("echo foo\\|bar && make test")).toEqual([
      "echo foo\\|bar",
      "make test",
    ]);
  });

  it("treats a quoted make target as one segment", () => {
    expect(parseSegments('make "test x" && make build')).toEqual([
      'make "test x"',
      "make build",
    ]);
  });

  it("attributes each link of a semicolon-chained git compound", () => {
    expect(
      parseSegments("git status; git branch; git log --oneline")
    ).toEqual(["git status", "git branch", "git log --oneline"]);
  });

  it("drops empty segments from leading, trailing, and doubled separators", () => {
    expect(parseSegments("make test && ")).toEqual(["make test"]);
    expect(parseSegments("; make test")).toEqual(["make test"]);
    expect(parseSegments("")).toEqual([]);
  });

  it("returns no segments for a non-string command", () => {
    expect(parseSegments(null)).toEqual([]);
    expect(parseSegments(undefined)).toEqual([]);
  });
});
