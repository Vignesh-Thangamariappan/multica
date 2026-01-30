import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getProfileSkillsDir, loadAllSkills, getBundledSkillsDir } from "./loader.js";

describe("loader", () => {
  const testBaseDir = join(tmpdir(), `multica-skills-test-${Date.now()}`);

  beforeEach(() => {
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true });
    }
    mkdirSync(testBaseDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true });
    }
  });

  describe("getProfileSkillsDir", () => {
    it("should return correct path with custom base dir", () => {
      const result = getProfileSkillsDir("my-profile", testBaseDir);
      expect(result).toBe(join(testBaseDir, "my-profile", "skills"));
    });

    it("should use default base dir when not provided", () => {
      const result = getProfileSkillsDir("my-profile");
      expect(result).toContain(".super-multica");
      expect(result).toContain("agent-profiles");
      expect(result).toContain("my-profile");
      expect(result).toContain("skills");
    });
  });

  describe("getBundledSkillsDir", () => {
    it("should return path to bundled skills", () => {
      const result = getBundledSkillsDir();
      expect(result).toContain("skills");
    });
  });

  describe("loadAllSkills", () => {
    function createSkillDir(baseDir: string, skillId: string, name: string) {
      const skillDir = join(baseDir, skillId);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---
name: ${name}
description: Test skill ${skillId}
---
Instructions for ${name}
`
      );
    }

    it("should load skills from extra directories", () => {
      const extraDir = join(testBaseDir, "extra-skills");
      mkdirSync(extraDir, { recursive: true });
      createSkillDir(extraDir, "custom-skill", "Custom Skill");

      const skills = loadAllSkills({ extraDirs: [extraDir] });

      expect(skills.has("custom-skill")).toBe(true);
      const skill = skills.get("custom-skill");
      expect(skill?.frontmatter.name).toBe("Custom Skill");
      expect(skill?.source).toBe("bundled");
    });

    it("should load skills from profile directory", () => {
      const profileDir = join(testBaseDir, "profiles", "test-profile", "skills");
      mkdirSync(profileDir, { recursive: true });
      createSkillDir(profileDir, "profile-skill", "Profile Skill");

      const skills = loadAllSkills({
        profileId: "test-profile",
        profileBaseDir: join(testBaseDir, "profiles"),
      });

      expect(skills.has("profile-skill")).toBe(true);
      const skill = skills.get("profile-skill");
      expect(skill?.frontmatter.name).toBe("Profile Skill");
      expect(skill?.source).toBe("profile");
    });

    it("should apply precedence: profile overrides bundled", () => {
      const extraDir = join(testBaseDir, "extra");
      mkdirSync(extraDir, { recursive: true });
      createSkillDir(extraDir, "same-id", "Bundled Version");

      const profileDir = join(testBaseDir, "profiles", "test-profile", "skills");
      mkdirSync(profileDir, { recursive: true });
      createSkillDir(profileDir, "same-id", "Profile Version");

      const skills = loadAllSkills({
        extraDirs: [extraDir],
        profileId: "test-profile",
        profileBaseDir: join(testBaseDir, "profiles"),
      });

      expect(skills.has("same-id")).toBe(true);
      const skill = skills.get("same-id");
      expect(skill?.frontmatter.name).toBe("Profile Version");
      expect(skill?.source).toBe("profile");
    });

    it("should return empty map when no skills found", () => {
      const emptyDir = join(testBaseDir, "empty");
      mkdirSync(emptyDir, { recursive: true });

      const skills = loadAllSkills({ extraDirs: [emptyDir] });

      // May contain bundled skills, but the empty extra dir shouldn't cause issues
      expect(skills).toBeInstanceOf(Map);
    });

    it("should skip invalid skill files", () => {
      const extraDir = join(testBaseDir, "with-invalid");
      mkdirSync(extraDir, { recursive: true });

      // Create valid skill
      createSkillDir(extraDir, "valid-skill", "Valid Skill");

      // Create invalid skill (no name in frontmatter)
      const invalidDir = join(extraDir, "invalid-skill");
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(
        join(invalidDir, "SKILL.md"),
        `---
description: Missing name field
---
Invalid skill
`
      );

      const skills = loadAllSkills({ extraDirs: [extraDir] });

      expect(skills.has("valid-skill")).toBe(true);
      expect(skills.has("invalid-skill")).toBe(false);
    });

    it("should skip directories without SKILL.md", () => {
      const extraDir = join(testBaseDir, "partial");
      mkdirSync(extraDir, { recursive: true });

      // Directory without SKILL.md
      const noSkillDir = join(extraDir, "not-a-skill");
      mkdirSync(noSkillDir, { recursive: true });
      writeFileSync(join(noSkillDir, "README.md"), "Just a readme");

      // Valid skill
      createSkillDir(extraDir, "real-skill", "Real Skill");

      const skills = loadAllSkills({ extraDirs: [extraDir] });

      expect(skills.has("real-skill")).toBe(true);
      expect(skills.has("not-a-skill")).toBe(false);
    });

    it("should handle non-existent directories gracefully", () => {
      const skills = loadAllSkills({
        extraDirs: ["/non/existent/path"],
      });

      expect(skills).toBeInstanceOf(Map);
    });

    it("should load multiple skills from same directory", () => {
      const extraDir = join(testBaseDir, "multi");
      mkdirSync(extraDir, { recursive: true });

      createSkillDir(extraDir, "skill-a", "Skill A");
      createSkillDir(extraDir, "skill-b", "Skill B");
      createSkillDir(extraDir, "skill-c", "Skill C");

      const skills = loadAllSkills({ extraDirs: [extraDir] });

      expect(skills.has("skill-a")).toBe(true);
      expect(skills.has("skill-b")).toBe(true);
      expect(skills.has("skill-c")).toBe(true);
    });
  });
});
