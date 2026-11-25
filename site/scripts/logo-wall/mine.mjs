#!/usr/bin/env node
// Mine the repo's stargazers and fork owners for employer signals and write a
// ranked candidate list to site/.logo-wall/candidates.json (gitignored: it
// holds GitHub logins). Nothing here renders on the site — a maintainer
// promotes entries into src/content/logo-wall/companies.json by hand.
//
//   GITHUB_TOKEN=… node scripts/logo-wall/mine.mjs      (falls back to `gh auth token`)
//   node scripts/logo-wall/mine.mjs --offline          (re-aggregate the cached raw pull)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { companyKey, splitCompanies, hostOf, hostMatchesKey } from "./normalize.mjs";

const OWNER = "KnockOutEZ";
const REPO = "wigolo";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", ".logo-wall");
const OUT = join(OUT_DIR, "candidates.json");
const RAW = join(OUT_DIR, "raw.json");
const OFFLINE = process.argv.includes("--offline");

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Set GITHUB_TOKEN or log in with `gh auth login`.");
  }
}

const TOKEN = OFFLINE ? "" : token();

async function gql(query, variables, attempt = 1) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if ((res.status >= 500 || res.status === 403) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return gql(query, variables, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors?.length) {
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return gql(query, variables, attempt + 1);
    }
    throw new Error(JSON.stringify(body.errors));
  }
  return body.data;
}

const ORG_FIELDS = "login name websiteUrl avatarUrl isVerified";
const USER_FIELDS = `login company email websiteUrl organizations(first: 10) { nodes { ${ORG_FIELDS} } }`;

const STARGAZERS = `query($cursor: String) {
  repository(owner: "${OWNER}", name: "${REPO}") {
    stargazers(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${USER_FIELDS} }
    }
  }
}`;

const FORKS = `query($cursor: String) {
  repository(owner: "${OWNER}", name: "${REPO}") {
    forks(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        owner {
          __typename
          ... on Organization { ${ORG_FIELDS} }
          ... on User { ${USER_FIELDS} }
        }
      }
    }
  }
}`;

async function paginate(query, pick, label) {
  const out = [];
  let cursor = null;
  for (;;) {
    const conn = pick(await gql(query, { cursor }));
    out.push(...conn.nodes);
    process.stderr.write(`\r${label}: ${out.length}`);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  process.stderr.write("\n");
  return out;
}

// "Verified" = GitHub-attested: a public org membership, an org-owned fork, or
// a public profile email on the company's own domain. A free-text company
// field alone is self-reported and stays unverified.
/** key → { people:Set, verified:Set, evidence:{}, names:{}, domains:{}, orgs:{} } */
const companies = new Map();
const aliases = new Map();

function entry(key) {
  if (!companies.has(key)) {
    companies.set(key, {
      people: new Set(),
      verified: new Set(),
      evidence: {},
      names: {},
      domains: {},
      orgs: {},
    });
  }
  return companies.get(key);
}

const bump = (obj, k) => {
  obj[k] = (obj[k] ?? 0) + 1;
};

function orgKey(org) {
  return companyKey(org.name || "") || companyKey(org.login);
}

function recordOrg(org, person, how) {
  const key = orgKey(org);
  if (!key) return;
  aliases.set(companyKey(org.login), key);
  if (org.name) aliases.set(companyKey(org.name), key);
  const e = entry(key);
  e.people.add(person);
  e.verified.add(person);
  bump(e.evidence, how);
  bump(e.names, org.name || org.login);
  e.orgs[org.login] = {
    name: org.name,
    website: org.websiteUrl,
    avatar: org.avatarUrl,
    verified: org.isVerified,
  };
  const host = hostOf(org.websiteUrl);
  if (host) bump(e.domains, host);
}

const pendingCompanyFields = [];

function recordUser(user, how) {
  for (const org of user.organizations?.nodes ?? []) recordOrg(org, user.login, `${how}:org-member`);
  for (const raw of splitCompanies(user.company ?? "")) {
    const key = companyKey(raw);
    if (key) pendingCompanyFields.push({ key, raw: raw.replace(/^@/, ""), user, how });
  }
}

let stargazers;
let forks;
if (OFFLINE) {
  if (!existsSync(RAW)) throw new Error(`No cached pull at ${RAW}; run once without --offline.`);
  ({ stargazers, forks } = JSON.parse(readFileSync(RAW, "utf8")));
} else {
  stargazers = await paginate(STARGAZERS, (d) => d.repository.stargazers, "stargazers");
  forks = await paginate(FORKS, (d) => d.repository.forks, "forks");
  mkdirSync(OUT_DIR, { recursive: true });
  // Keep only the email's domain on disk — the address itself is never needed.
  const scrub = (u) => u && u.email !== undefined && (u.email = u.email ? `@${u.email.split("@")[1] ?? ""}` : "");
  stargazers.forEach(scrub);
  forks.forEach((f) => scrub(f.owner));
  writeFileSync(RAW, JSON.stringify({ fetchedAt: new Date().toISOString(), stargazers, forks }));
}

for (const u of stargazers) recordUser(u, "star");
for (const { owner } of forks) {
  if (owner.__typename === "Organization") recordOrg(owner, `org:${owner.login}`, "org-fork");
  else recordUser(owner, "fork");
}

// Company fields resolve after every org is seen, so "@optimizely" lands on
// the same key as the Optimizely org regardless of scan order.
for (const { key, raw, user, how } of pendingCompanyFields) {
  const canonical = aliases.get(key) ?? key;
  const e = entry(canonical);
  e.people.add(user.login);
  bump(e.evidence, `${how}:company-field`);
  bump(e.names, raw);
  const host = hostOf(user.websiteUrl);
  if (hostMatchesKey(host, canonical)) bump(e.domains, host);
  const mailHost = (user.email ?? "").split("@")[1]?.toLowerCase() ?? "";
  if (hostMatchesKey(mailHost, canonical)) {
    e.verified.add(user.login);
    bump(e.evidence, `${how}:email-domain`);
    bump(e.domains, mailHost);
  }
}

const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

const candidates = [...companies.entries()]
  .map(([key, e]) => ({
    key,
    name: top(e.names),
    people: e.people.size,
    verified: e.verified.size,
    evidence: e.evidence,
    domain: top(e.domains),
    githubOrgs: e.orgs,
    logins: [...e.people].sort(),
  }))
  .filter((c) => c.people > 0)
  .sort((a, b) => b.people - a.people || a.key.localeCompare(b.key));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      stargazers: stargazers.length,
      forks: forks.length,
      withEmployerSignal: new Set(candidates.flatMap((c) => c.logins)).size,
      candidates,
    },
    null,
    2,
  ),
);

console.error(`\n${candidates.length} companies → ${OUT}\nTop 40:`);
for (const c of candidates.slice(0, 40)) {
  console.error(`  ${String(c.people).padStart(3)} (${c.verified}✓)  ${c.name}  ${c.domain ?? ""}  ${Object.keys(c.githubOrgs).join(",")}`);
}
