import { scanSubmissionContent } from "../../features/submissions-dashboard/utils/scanner";

describe("scanSubmissionContent", () => {
  it("should return Passed when content is empty", () => {
    const result = scanSubmissionContent("");
    expect(result.score).toBe("Passed");
    expect(result.flags.length).toBe(0);
  });

  it("should return Passed for safe content", () => {
    const result = scanSubmissionContent("const a = 1; console.log(a);");
    expect(result.score).toBe("Passed");
    expect(result.flags.length).toBe(0);
  });

  it("should flag exposed Stripe live API keys as Critical", () => {
    const result = scanSubmissionContent('const key = "sk_live_1234567890abcdef";');
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Exposed API Key");
  });

  it("should flag exposed Stripe test API keys as Critical", () => {
    const result = scanSubmissionContent('const key = "sk_test_1234567890abcdef";');
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Exposed API Key");
  });

  it("should flag exposed AWS AKIA keys as Critical", () => {
    const result = scanSubmissionContent('const aws = "AKIAIOSFODNN7EXAMPLE";');
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Exposed API Key");
  });

  it("should flag general api_key patterns as Critical", () => {
    const result = scanSubmissionContent('const api_key = "abcdef1234567890abc";');
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Exposed API Key");
  });

  it("should flag eval calls as Critical", () => {
    const result = scanSubmissionContent("eval('console.log(1)');");
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Dangerous Eval");
  });

  it("should flag new Function calls as Critical", () => {
    const result = scanSubmissionContent("const fn = new Function('a', 'return a');");
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Dangerous Eval");
  });

  it("should flag setTimeout with string as Critical", () => {
    const result = scanSubmissionContent("setTimeout('console.log(1)', 1000);");
    expect(result.score).toBe("Critical");
    expect(result.flags[0].type).toBe("Dangerous Eval");
  });

  it("should flag window.location redirects as Warning", () => {
    const result = scanSubmissionContent("window.location = 'http://malicious.com';");
    expect(result.score).toBe("Warning");
    expect(result.flags[0].type).toBe("Malicious Redirect");
  });

  it("should flag meta refresh redirects as Warning", () => {
    const result = scanSubmissionContent('<meta http-equiv="refresh" content="0; url=http://example.com" />');
    expect(result.score).toBe("Warning");
    expect(result.flags[0].type).toBe("Malicious Redirect");
  });

  // False positive handling tests
  it("should not flag innocuous variables named api_key without long values", () => {
    const result = scanSubmissionContent("let api_key = null;");
    expect(result.score).toBe("Passed");
  });

  it("should not flag setTimeout with function reference", () => {
    const result = scanSubmissionContent("setTimeout(() => console.log(1), 1000);");
    expect(result.score).toBe("Passed");
  });
});
