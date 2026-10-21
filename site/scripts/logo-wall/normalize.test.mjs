import { test } from "node:test";
import assert from "node:assert/strict";
import { companyKey, splitCompanies, hostOf, hostMatchesKey, floorTo } from "./normalize.mjs";

test("the @handle, legal suffix and casing variants of one employer share a key", () => {
  // Counting depends on this: three spellings must add up to one company.
  assert.equal(companyKey("@Optimizely"), "optimizely");
  assert.equal(companyKey("Optimizely, Inc."), "optimizely");
  assert.equal(companyKey("OPTIMIZELY"), "optimizely");
  assert.equal(companyKey("Brain Station 23 Ltd."), "brain station 23");
});

test("status words are not employers", () => {
  // Otherwise "Freelance" would top the wall.
  for (const v of ["Freelance", "student", "N/A", "self-employed", "@github", "  ", "<%= null %>", "individual"]) {
    assert.equal(companyKey(v), "", v);
  }
});

test("multi-employer fields split, and former employers are dropped", () => {
  assert.deepEqual(splitCompanies("@acme @beta"), ["@acme", "@beta"]);
  assert.deepEqual(splitCompanies("Acme | Beta"), ["Acme", "Beta"]);
  // A former employer must not be listed as a company whose engineers star us now.
  assert.deepEqual(splitCompanies("ex-Google, Acme"), ["Acme"]);
});

test("names containing separators stay whole", () => {
  // A mis-split turns one university into two fake companies.
  assert.deepEqual(splitCompanies("University of Science and Technology of China"), [
    "University of Science and Technology of China",
  ]);
  assert.deepEqual(splitCompanies("AT&T"), ["AT&T"]);
  assert.deepEqual(splitCompanies("Acme / Beta"), ["Acme", "Beta"]);
});

test("a URL in the company field becomes its domain label, not 'https:'", () => {
  assert.deepEqual(splitCompanies("https://www.acme.io/about"), ["acme"]);
  assert.deepEqual(splitCompanies("https://me.github.io"), []);
});

test("a personal site never counts as company evidence", () => {
  assert.equal(hostMatchesKey("omranjamal.github.io", "omranjamal"), false);
  assert.equal(hostMatchesKey("optimizely.com", "optimizely"), true);
  assert.equal(hostMatchesKey(hostOf("https://www.optimizely.com/x"), "optimizely"), true);
  assert.equal(hostMatchesKey("randomblog.com", "optimizely"), false);
});

test("caption counts round down so the claim never overstates", () => {
  assert.equal(floorTo(5395), 5300);
  assert.equal(floorTo(99), 0);
  assert.equal(floorTo(Number.NaN), 0);
});
