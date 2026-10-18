import {
  parseSpdxExpression,
  scanDependencyLicenses,
} from "../../features/submissions-dashboard/utils/licenseScanner";

describe("SPDX license compliance scanner", () => {
  it("parses SPDX operators, parentheses, and WITH exceptions", () => {
    expect(parseSpdxExpression("(MIT OR Apache-2.0) AND GPL-2.0-only WITH Classpath-exception-2.0")).not.toBeNull();
    expect(parseSpdxExpression("MIT OR")).toBeNull();
  });

  it("allows permissive licenses", () => {
    const audit = scanDependencyLicenses([{ name: "safe-package", license: "MIT" }]);

    expect(audit.status).toBe("Passed");
    expect(audit.passed).toBe(1);
  });

  it("flags GPL and AGPL dependencies as incompatible with commercial distribution", () => {
    const audit = scanDependencyLicenses([
      { name: "gpl-package", license: "GPL-3.0-only" },
      { name: "agpl-package", license: "AGPL-3.0-or-later" },
    ]);

    expect(audit.status).toBe("Incompatible");
    expect(audit.incompatible).toBe(2);
  });

  it("requires review for weak copyleft and unknown or missing license metadata", () => {
    const audit = scanDependencyLicenses([
      { name: "weak-package", license: "LGPL-2.1-or-later" },
      { name: "unknown-package", license: "LicenseRef-Internal" },
      { name: "unreported-package" },
    ]);

    expect(audit.status).toBe("Warning");
    expect(audit.warnings).toBe(3);
  });

  it("accepts an SPDX OR expression when a permissive option is available", () => {
    const audit = scanDependencyLicenses([{ name: "dual-license", license: "GPL-3.0-only OR MIT" }]);

    expect(audit.status).toBe("Passed");
  });
});