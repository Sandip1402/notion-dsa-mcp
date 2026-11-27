import dotenvx from '@dotenvx/dotenvx';
dotenvx.config();

import { Client, isFullDatabase } from "@notionhq/client";
import { Credential, LeetCode } from "leetcode-query";

const LEETCODE_SESSION = process.env.LEETCODE_SESSION;
const LEETCODE_USERNAME = process.env.LEETCODE_USERNAME;
const NOTION_API_KEY = process.env.NOTION_PAT;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const TEST_SLUG = "two-sum";

// Set to true if you also want to create + archive a temporary test row in Notion
const WRITE_NOTION_TEST_ROW = false;

async function testLeetCodePublic() {
  console.log("\n--- 1. Testing LeetCode Public API (question) ---");
  const lc = new LeetCode();
  const q = await lc.problem(TEST_SLUG);

  if (!q?.title) {
    throw new Error(`Failed to fetch public problem "${TEST_SLUG}"`);
  }

  console.log("OK:", {
    id: q.questionFrontendId,
    title: q.title,
    difficulty: q.difficulty,
    topics: q.topicTags?.map((t: { name: string }) => t.name),
  });
}

async function testLeetCodeAuth() {
  console.log("\n--- 2. Testing LeetCode Authenticated Client ---");
  if (!LEETCODE_SESSION) {
    console.log("SKIP: LEETCODE_SESSION not set in .env");
    return;
  }

  const credential = new Credential();
  await credential.init(LEETCODE_SESSION);
  const lc = new LeetCode(credential);

  if (LEETCODE_USERNAME) {
    const recent = await lc.recent_submissions(LEETCODE_USERNAME, 3);
    console.log("OK recent_submissions count:", recent.length);
  }

  const subs = await lc.submissions({ limit: 3, offset: 0 });
  console.log("OK authenticated submissions count:", subs.length ?? 0);
}

async function testNotionRead() {
  console.log("\n--- 3. Testing Notion Auth, Database & Data Source ---");
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    throw new Error("NOTION_API_KEY or NOTION_DATABASE_ID missing in .env");
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });

  if (!isFullDatabase(db)) {
    console.log("WARN: Retrieved partial database object (check integration permissions).");
    return;
  }

  console.log("OK database properties:", Object.keys(db.object));

  const dataSourceId = db.data_sources[0]?.id;
  if (!dataSourceId) {
    throw new Error("No data_source_id found on database");
  }

  const queryRes = await notion.dataSources.query({
    data_source_id: dataSourceId,
    page_size: 1,
  });
  console.log("OK dataSources.query (rows returned):", queryRes.results.length);

  return { notion, dataSourceId };
}

async function testNotionWrite(notion: Client, dataSourceId: string) {
  console.log("\n--- 4. Testing Notion Create + Archive (Cleanup) ---");
  const created = await notion.pages.create({
    parent: { data_source_id: dataSourceId },
    properties: {
      Problem: {
        title: [{ text: { content: "[TEST] Two Sum" } }],
      },
      Status: {
        status: { name: "Solved" },
      },
      Topics: {
        multi_select: [{ name: "Array" }],
      },
      Difficulty: {
        select: { name: "Easy" },
      },
      "LC #": {
        number: 1,
      },
      "Date Solved": {
        date: { start: new Date().toISOString().slice(0, 10) },
      },
      Link: {
        url: "https://leetcode.com/problems/two-sum/",
      },
    },
  });

  console.log("OK created test page:", created.id);

  // Clean up test page so your Notion tracker stays clean
  await notion.pages.update({
    page_id: created.id,
    in_trash: true,
  });
  console.log("OK moved test page to trash");
}

async function main() {
  try {
    await testLeetCodePublic();
    await testLeetCodeAuth();
    const notionCtx = await testNotionRead();

    if (WRITE_NOTION_TEST_ROW && notionCtx) {
      await testNotionWrite(notionCtx.notion, notionCtx.dataSourceId);
    }

    console.log("\nAll enabled API checks passed.");
  } catch (err) {
    console.error("\nAPI check failed:", err);
    process.exitCode = 1;
  }
}

main();