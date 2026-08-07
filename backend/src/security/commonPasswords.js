"use strict";

/**
 * Blocklist of passwords that appear at the top of public breach corpora
 * (rockyou, HaveIBeenPwned top lists, SecLists) plus terms specific to this
 * product that users predictably reach for.
 *
 * WHY: Credential-stuffing tooling tries these first. Blocking them removes the
 * cheapest attack path at zero cost to legitimate users.
 *
 * NOTE: This is an embedded floor, not a replacement for a full breach corpus.
 * For stronger coverage, enable the k-anonymity Pwned Passwords range check by
 * setting PWNED_PASSWORDS_CHECK=true (see passwordPolicy consumers); that sends
 * only the first 5 characters of the SHA-1 hash, never the password itself.
 */

const COMMON_PASSWORDS = new Set([
  // Universal top offenders
  "123456", "123456789", "12345678", "1234567890", "12345", "1234567", "111111",
  "password", "password1", "password123", "passw0rd", "qwerty", "qwerty123",
  "qwertyuiop", "abc123", "letmein", "welcome", "welcome1", "welcome123",
  "monkey", "dragon", "sunshine", "princess", "football", "baseball", "iloveyou",
  "admin", "admin123", "administrator", "root", "toor", "guest", "test", "test123",
  "changeme", "default", "secret", "master", "shadow", "superman", "batman",
  "trustno1", "starwars", "whatever", "zaq12wsx", "asdfghjkl", "qazwsx",
  "1q2w3e4r", "1qaz2wsx", "q1w2e3r4", "zxcvbnm", "michael", "jennifer",
  "jordan", "harley", "ranger", "hunter", "buster", "soccer", "hockey",
  "killer", "george", "andrew", "charlie", "thomas", "robert", "daniel",
  "matthew", "access", "flower", "hello", "freedom", "ninja", "azerty",
  "loveme", "cheese", "computer", "internet", "samsung", "google", "facebook",
  "linkedin", "twitter", "myspace", "yahoo", "hotmail", "gmail",
  "letmein123", "iloveyou1", "sunshine1", "princess1", "michael1",

  // Long-but-weak strings that clear a naive length check
  "passwordpassword", "password1234", "password12345", "password123456",
  "qwertyuiopasdfgh", "abcdefghijkl", "abcdefghijklmnop", "aaaaaaaaaaaa",
  "1234567890123456", "123456789012", "111111111111", "000000000000",
  "iloveyouforever", "letmeinplease", "trustnoone1234", "administrator1",
  "welcometothejungle", "thisismypassword", "mypasswordis123",
  "correcthorsebatterystaple", "qwertyuiop123456", "asdfghjkl123456",

  // Product / domain specific — predictable for this application
  "datahub", "datahub123", "datahub2024", "datahub2025", "datahub2026",
  "centurium", "centurium123", "sagehealthy", "quickbooks", "quickbooks123",
  "finance", "finance123", "accounting", "accounting123", "broker", "broker123",
  "company", "company123", "business", "business123", "dataroom", "dataroom123",
  "mergers", "acquisitions", "duediligence", "balancesheet", "profitloss",

  // Seasonal / date patterns
  "summer2024", "summer2025", "summer2026", "winter2024", "winter2025",
  "spring2024", "spring2025", "autumn2024", "january2025", "december2025",
  "monday123", "friday123",
]);

module.exports = { COMMON_PASSWORDS };
