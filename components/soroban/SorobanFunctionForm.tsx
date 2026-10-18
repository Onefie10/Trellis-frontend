"use client";

import { FormEvent, useState } from "react";
import type { SorobanFunctionSpec } from "@/lib/types";
import { getSorobanInputType, parseFormValue, serializeSorobanValue, validateSorobanValue } from "@/lib/soroban/values";

interface SorobanFunctionFormProps {
  functionSpec: SorobanFunctionSpec;
  onSubmit: (values: Record<string, unknown>, scVals: ReturnType<typeof serializeSorobanValue>[]) => void | Promise<void>;
  disabled?: boolean;
}

export default function SorobanFunctionForm({ functionSpec, onSubmit, disabled = false }: SorobanFunctionFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(functionSpec.args.map((arg) => [arg.name, ""])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleFieldChange(argName: string, nextValue: string) {
    setValues((current) => ({ ...current, [argName]: nextValue }));
    if (errors[argName]) {
      setErrors((current) => {
        const copy = { ...current };
        delete copy[argName];
        return copy;
      });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const arg of functionSpec.args) {
      try {
        const value = parseFormValue(arg.type, values[arg.name] ?? "");
        const error = validateSorobanValue(arg.type, value);
        if (error) nextErrors[arg.name] = error;
        else parsed[arg.name] = value;
      } catch { nextErrors[arg.name] = "Enter valid JSON for this value."; }
    }
    setErrors(nextErrors);
    const firstInvalidArg = Object.keys(nextErrors)[0];
    if (firstInvalidArg) {
      const targetId = `soroban-${functionSpec.name}-${firstInvalidArg}`;
      document.getElementById(targetId)?.focus();
      return;
    }
    try {
      await onSubmit(parsed, functionSpec.args.map((arg) => serializeSorobanValue(arg.type, parsed[arg.name])));
      setSubmitError(null);
    } catch (error) { setSubmitError(error instanceof Error ? error.message : "Unable to serialize contract arguments."); }
  }

  return <form onSubmit={handleSubmit} className="space-y-4" noValidate aria-label={`Soroban function ${functionSpec.name}`}>
    {functionSpec.args.map((arg) => {
      const input = getSorobanInputType(arg.type);
      const id = `soroban-${functionSpec.name}-${arg.name}`;
      const errorId = `${id}-error`;
      const hasError = Boolean(errors[arg.name]);
      const isRequired = input.kind !== "optional";
      return <div key={arg.name}>
        <label htmlFor={id} className="mb-1 block text-sm font-medium">{arg.name}<span className="ml-2 text-xs opacity-60">{arg.type}</span></label>
        {input.kind === "boolean" ? <select id={id} value={values[arg.name]} onChange={(event) => handleFieldChange(arg.name, event.target.value)} aria-required={isRequired} aria-invalid={hasError} aria-describedby={hasError ? errorId : undefined} className="w-full rounded border p-2" disabled={disabled}><option value="">Choose…</option><option value="true">true</option><option value="false">false</option></select> : input.kind === "json" ? <textarea id={id} value={values[arg.name]} onChange={(event) => handleFieldChange(arg.name, event.target.value)} aria-required={isRequired} aria-invalid={hasError} aria-describedby={hasError ? errorId : undefined} placeholder={input.type.startsWith("Map") ? '[{"key":"...","value":"..."}]' : "[...]"} className="min-h-24 w-full rounded border p-2 font-mono text-sm" disabled={disabled} /> : <input id={id} type={input.kind === "number" ? "text" : "text"} inputMode={input.kind === "number" ? "numeric" : "text"} value={values[arg.name]} onChange={(event) => handleFieldChange(arg.name, event.target.value)} aria-required={isRequired} aria-invalid={hasError} aria-describedby={hasError ? errorId : undefined} placeholder={input.kind === "address" ? "G... or C..." : input.kind === "optional" ? "Leave blank for None" : undefined} className="w-full rounded border p-2" disabled={disabled} />}
        {errors[arg.name] && <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">{errors[arg.name]}</p>}
      </div>;
    })}
    {submitError && <p className="text-xs text-red-600" role="alert" aria-live="assertive">{submitError}</p>}
    <button type="submit" disabled={disabled} className="rounded bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Prepare {functionSpec.name}</button>
  </form>;
}
