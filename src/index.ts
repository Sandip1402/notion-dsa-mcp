import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client } from "@notionhq/client";
import * as z from "zod/v4";
import {LeetCode, Credential} from "leetcode-query";
import dotenvx from '@dotenvx/dotenvx';
dotenvx.config();

const DATASOURCE_ID = process.env.NOTION_DATASOURCE_ID!;
const session = process.env.LEETCODE_SESSION ?? "";
const csrf = process.env.LEETCODE_CSRF_TOKEN ?? "";
const username = process.env.LEETCODE_USERNAME ?? "";

const notion = new Client({ auth: process.env.NOTION_PAT! });

const credential = new Credential();
await credential.init(session);
const leetcode = new LeetCode(credential);
const user = await leetcode.user(username);


// const dataSource = await notion.dataSources.retrieve({ data_source_id: DATASOURCE_ID });

async function fetchLeetCodeQuestion(titleSlug: string) {
  const query = `
    query getQuestionDetail($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionFrontendId
        titleSlug
        title
        difficulty
        topicTags {
          name
        }
      }
    }
  `;

  /*
    e.g, response -
    {
      "data": {
          "question": {
              "questionFrontendId": "2",
              "titleSlug": "add-two-numbers",
              "title": "Add Two Numbers",
              "difficulty": "Medium",
              "topicTags": [
                  {
                      "name": "Linked List"
                  },
                  {
                      "name": "Math"
                  },
                  {
                      "name": "Recursion"
                  }
              ]
          }
      }
    }
  */

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Ageng": "Chrome/157.0.0.0",
    Referer: `https://leetcode.com/problems/${titleSlug}/`,
  };
  if (session) {
    headers.Cookie = `LEETCODE_SESSION=${session}; csrftoken=${csrf}`;
  }
  if(csrf) {
    headers["x-csrftoken"] = csrf;
  }

  const res = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: { titleSlug } }),
  });

  if (!res.ok) {
    throw new Error(`LeetCode GraphQL error: ${res.status}`);
  }

  const json = await res.json();
  return json.data?.question;
}

type Status = "Not Started" | "In Progress" | "Solved";
type Difficulty = "Easy" | "Medium" | "Hard";

interface LeetCodeProblem {
  Problem: string;
  Status: Status | null;
  Topics: string[];
  Difficulty: Difficulty | null;
  "LC #": number | null;
  "Date Solved": string | null; // ISO date, e.g. "2026-11-22"
  Link: string | null;
}


async function upsertProblem(item: LeetCodeProblem) {

  const filter =
    item["LC #"] !== null
      ? { property: "LC #", number: { equals: item["LC #"] } }
      : { property: "Problem", title: { equals: item.Problem } };

  const existing = await notion.dataSources.query({
    data_source_id: DATASOURCE_ID,
    filter: filter
  });

  const properties: Record<string, any> = {
    Problem: {
      title: [{ text: { content: item.Problem } }],
    },
    Status: item.Status ? { status: { name: item.Status } } : { status: null },
    Topics: {
      multi_select: item.Topics.map((name) => ({ name })),
    },
    Difficulty: item.Difficulty
      ? { select: { name: item.Difficulty } }
      : { select: null },
    "LC #": {
      number: item["LC #"],
    },
    "Date Solved": item["Date Solved"]
      ? { date: { start: item["Date Solved"] } }
      : { date: null },
    Link: {
      url: item.Link,
    },
  };

  const existingPage = existing.results[0];
  const action = existingPage ? "updated" : "created";

  const page = existingPage
    ? await notion.pages.update({ page_id: existingPage.id, properties })
    : await notion.pages.create({
      parent: { data_source_id: DATASOURCE_ID },
      properties,
    });

  return { page, action };
}

function createServer(): McpServer {

  const server = new McpServer({ name: "leetcode-notion-sync", version: "1.0.0", });

  server.registerTool(
    "sync_leetcode_problem",
    {
      description: "Fetch a LeetCode problem's metadata and sync its solve status into Notion",
      inputSchema: z.object({
        problem: z.string().describe("LeetCode problem slug, e.g. 'two-sum'"),
        status: z.enum(["Not Started" , "In Progress" , "Solved"]).default("Solved"),
        date_solved: z.string().default(() => new Date().toISOString().slice(0, 10))
      })
    },
    async ({ problem, status, date_solved }) => {
      const titleSlug = problem.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const q = await fetchLeetCodeQuestion(titleSlug);
      if (!q) {
        return {
          content: [{ type: "text", text: `Problem '${problem}' not found on LeetCode.` }],
          isError: true,
        };
      }

      /* 
        questionFrontendId
        title
        difficulty
        topicTags { name }
      */
      const result = await upsertProblem({
        Problem: q.title,
        Status: status, // or pass from caller / default to "In Progress" if just logging
        Topics: q.topicTags.map((t: { name: string }) => t.name),
        Difficulty: q.difficulty, // lowercase `difficulty` from GraphQL
        "LC #": Number(q.questionFrontendId) || null,
        "Date Solved": date_solved, // "YYYY-MM-DD", or null if not solved
        Link: `https://leetcode.com/problems/${q.titleSlug}/`,
      });

      return {
        content: [
          {
            type: "text",
            text: `${result.action.toUpperCase()}: ${q.questionFrontendId}. ${q.title} [${status}] (Page ID: ${result.page.id})`,
          },
        ],
      };
    }
  )

  server.registerTool(
    "get-question-detail",
    {
      description: "Fetch a leetcode problem",
      inputSchema: z.object({
        Problem: z.string().describe("LeetCode problem slug, e.g. 'two-sum'"),
      })
    },
    async ({ Problem }) => {
      const titleSlug = Problem.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const q = await fetchLeetCodeQuestion(titleSlug);
      if (!q) {
        return {
          content: [{ type: "text", text: `Problem '${Problem}' not found on LeetCode.` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${q.questionFrontendId}. ${q.title} ${q.difficulty} ${q.topicTags.map((t: { name: string }) => t.name)}`
          },
        ],
      };
    }
  )

  return server;
}

void serveStdio(createServer);
console.error('leetcode-notion MCP server running on stdio');

// async function main() {
//   serveStdio
// }

// main().catch((err) => {
//   console.error("MCP server error:", err);
//   process.exit(1);
// });