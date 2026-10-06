"use client";

import { useEffect, useState } from "react";
import type { Profile, ProfileInput } from "@/lib/api";

type GenderChoice = "prefer-not" | "Woman" | "Man" | "Non-binary" | "self";

const GENDER_LABELS: Array<Exclude<GenderChoice, "prefer-not" | "self">> = ["Woman", "Man", "Non-binary"];

function genderChoice(gender: string | null | undefined): { choice: GenderChoice; self: string } {
  if (!gender) return { choice: "prefer-not", self: "" };
  if (GENDER_LABELS.includes(gender as Exclude<GenderChoice, "prefer-not" | "self">)) {
    return { choice: gender as GenderChoice, self: "" };
  }
  return { choice: "self", self: gender };
}

export function ProfileForm({
  initial,
  submitLabel,
  pending = false,
  onSubmit,
}: {
  initial: { name: string; profile?: Partial<Profile> | null };
  submitLabel: string;
  pending?: boolean;
  onSubmit: (profile: ProfileInput) => void;
}) {
  const starting = genderChoice(initial.profile?.gender);
  const [name, setName] = useState(initial.name);
  const [choice, setChoice] = useState<GenderChoice>(starting.choice);
  const [self, setSelf] = useState(starting.self);
  const [profession, setProfession] = useState(initial.profile?.profession ?? "");
  const [organization, setOrganization] = useState(initial.profile?.organization ?? "");
  const [heardFrom, setHeardFrom] = useState(initial.profile?.heardFrom ?? "");

  useEffect(() => {
    const next = genderChoice(initial.profile?.gender);
    setName(initial.name);
    setChoice(next.choice);
    setSelf(next.self);
    setProfession(initial.profile?.profession ?? "");
    setOrganization(initial.profile?.organization ?? "");
    setHeardFrom(initial.profile?.heardFrom ?? "");
  }, [initial.name, initial.profile?.gender, initial.profile?.profession, initial.profile?.organization, initial.profile?.heardFrom]);

  const gender = choice === "prefer-not" ? null : choice === "self" ? self.trim() || null : choice;
  const disabled = pending || name.trim().length === 0;
  return (
    <form
      className="space-y-3"
      data-profile-form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          name: name.trim(),
          gender,
          profession: profession.trim() || null,
          organization: organization.trim() || null,
          heardFrom: heardFrom.trim() || null,
        });
      }}
    >
      <label className="block text-[13px] font-medium">
        Full name
        <input
          required
          maxLength={80}
          autoComplete="name"
          className="field mt-1.5 w-full"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div>
        <label className="block text-[13px] font-medium">
          Gender <span className="font-normal text-muted">(optional)</span>
          <select className="field mt-1.5 w-full" value={choice} onChange={(event) => setChoice(event.target.value as GenderChoice)}>
            <option value="prefer-not">Prefer not to say</option>
            <option value="Woman">Woman</option>
            <option value="Man">Man</option>
            <option value="Non-binary">Non-binary</option>
            <option value="self">Prefer to self-describe</option>
          </select>
        </label>
        {choice === "self" ? (
          <input
            aria-label="Self-described gender"
            maxLength={40}
            className="field mt-2 w-full"
            value={self}
            onChange={(event) => setSelf(event.target.value)}
          />
        ) : null}
      </div>
      <label className="block text-[13px] font-medium">
        Profession <span className="font-normal text-muted">(optional)</span>
        <input
          maxLength={80}
          className="field mt-1.5 w-full"
          placeholder="e.g. Software engineer"
          value={profession}
          onChange={(event) => setProfession(event.target.value)}
        />
      </label>
      <label className="block text-[13px] font-medium">
        Organization <span className="font-normal text-muted">(optional)</span>
        <input
          maxLength={80}
          className="field mt-1.5 w-full"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        />
      </label>
      <label className="block text-[13px] font-medium">
        How did you hear about Ensemble? <span className="font-normal text-muted">(optional)</span>
        <input
          maxLength={120}
          className="field mt-1.5 w-full"
          value={heardFrom}
          onChange={(event) => setHeardFrom(event.target.value)}
        />
      </label>
      <button type="submit" className="btn-primary" disabled={disabled}>
        {pending ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}
