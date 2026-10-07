import {
  ApiErrorSchema,
  CONTENT_ROLES,
  createProjectTextDocument,
  createSongTextDocument,
  deleteDocument,
  deleteDocumentVersion,
  getDocument,
  listDocumentVersions,
  listProjectDocuments,
  listSongDocuments,
  restoreDocument,
  restoreDocumentVersion,
  retryDocumentVersion,
  saveDocumentText,
  setCurrentDocumentVersion,
  updateDocument,
  createComment,
  createMarker,
  deleteComment,
  getProjectFollow,
  getSongFollow,
  listMentionableUsers,
  listSongComments,
  resolveComment,
  restoreComment,
  setCommentReaction,
  setProjectFollow,
  setSongFollow,
  updateComment,
  createSong,
  deleteSongTempo,
  getSongTempo,
  importSongTempoMidi,
  listTempoRevisions,
  putSongTempo,
  deleteProject,
  deleteSong,
  getProject,
  getSong,
  getSongWhatsNew,
  hasCapability,
  listProjectGrants,
  listProjectSongs,
  listSongGrants,
  listSongMarkers,
  recordSongVisit,
  removeProjectGrant,
  removeSongGrant,
  reorderSongs,
  setProjectGrant,
  setSongGrant,
  transferProjectOwnership,
  updateProject,
  updateSong,
  createProjectLink,
  createSongLink,
  getLinkAnalytics,
  listProjectLinks,
  listSongLinks,
  revokeLink,
  updateLink,
  getProjectOfflineManifest,
  getSongOfflineManifest,
  recordProjectOffline,
  recordSongOffline,
  type ContentRole,
  type ContractDef,
} from "@bandroom/shared";
import {
  addDocumentVersion,
  createAsset,
  createCommentRow,
  createDocumentWithVersion,
  createLinkRow,
  createProjectRow,
  findUserByLogin,
  createSongRow,
  setProjectGrantRow,
  updateProjectRow,
} from "@bandroom/server-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkScope } from "../http/scope";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

/**
 * Scoped authorization with real data: a member whose project role is set by a grant, for every
 * content role, against every project/song-scoped endpoint. Invisible → NOT_FOUND, visible but
 * lacking the capability → FORBIDDEN, otherwise allowed (SPEC §3, §18.3, §20).
 */
type Fixture = {
  cookie: string;
  projectId: string;
  songId: string;
  commentId: string;
  documentId: string;
  /** v1 and v2 of the document, both uploaded by the role's user. */
  docV1: string;
  docV2: string;
  /** A song link and a project link of the role's project. */
  linkId: string;
  projectLinkId: string;
};
type Endpoint = {
  name: string;
  contract: ContractDef;
  scope: "project" | "song" | "comment" | "document" | "documentVersion" | "link" | "projectLink";
  body?: unknown;
  bodyFor?: (f: Fixture) => unknown;
};

const LINK_BODY = (scopeType: "project" | "song") => ({
  scopeType,
  label: "L",
  content: "all-tracks",
  versions: "current-only",
  expiresAt: null,
  allowDownload: false,
  allowComments: false,
  showComments: false,
});

const ENDPOINTS: Endpoint[] = [
  { name: "getProject", contract: getProject, scope: "project" },
  {
    name: "getProjectOfflineManifest",
    contract: getProjectOfflineManifest,
    scope: "project",
  },
  {
    name: "recordProjectOffline",
    contract: recordProjectOffline,
    scope: "project",
    body: { action: "added", bytes: 1, quality: "normal" },
  },
  { name: "getSongOfflineManifest", contract: getSongOfflineManifest, scope: "song" },
  {
    name: "recordSongOffline",
    contract: recordSongOffline,
    scope: "song",
    body: { action: "removed", bytes: 0, quality: "small" },
  },
  { name: "listProjectSongs", contract: listProjectSongs, scope: "project" },
  { name: "updateProject", contract: updateProject, scope: "project", body: { description: "x" } },
  { name: "createSong", contract: createSong, scope: "project", body: { title: "New" } },
  { name: "reorderSongs", contract: reorderSongs, scope: "project", body: { songIds: [] } },
  { name: "listProjectGrants", contract: listProjectGrants, scope: "project" },
  {
    name: "setProjectGrant",
    contract: setProjectGrant,
    scope: "project",
    body: { role: "viewer" },
  },
  { name: "removeProjectGrant", contract: removeProjectGrant, scope: "project" },
  {
    name: "transferProjectOwnership",
    contract: transferProjectOwnership,
    scope: "project",
    body: { userId: "missing" },
  },
  { name: "getSong", contract: getSong, scope: "song" },
  { name: "updateSong", contract: updateSong, scope: "song", body: { key: "Am" } },
  { name: "listSongGrants", contract: listSongGrants, scope: "song" },
  { name: "setSongGrant", contract: setSongGrant, scope: "song", body: { role: "viewer" } },
  { name: "removeSongGrant", contract: removeSongGrant, scope: "song" },
  { name: "listSongMarkers", contract: listSongMarkers, scope: "song" },
  {
    name: "createMarker",
    contract: createMarker,
    scope: "song",
    body: { type: "marker", name: "M", color: "red", startSec: 1 },
  },
  { name: "getSongWhatsNew", contract: getSongWhatsNew, scope: "song" },
  { name: "getSongTempo", contract: getSongTempo, scope: "song" },
  {
    name: "putSongTempo",
    contract: putSongTempo,
    scope: "song",
    body: {
      map: { segments: [{ startBeat: 0, bpm: 100, meter: { num: 4, den: 4 } }] },
      bar1OffsetSec: 0,
    },
  },
  {
    name: "importSongTempoMidi",
    contract: importSongTempoMidi,
    scope: "song",
    body: { fileName: "x.mid", data: "AAAA", markers: [] },
  },
  { name: "listTempoRevisions", contract: listTempoRevisions, scope: "song" },
  { name: "deleteSongTempo", contract: deleteSongTempo, scope: "song" },
  { name: "recordSongVisit", contract: recordSongVisit, scope: "song" },
  { name: "listSongComments", contract: listSongComments, scope: "song" },
  { name: "createComment", contract: createComment, scope: "song", body: { body: "Hi" } },
  { name: "listMentionableUsers", contract: listMentionableUsers, scope: "song" },
  { name: "getSongFollow", contract: getSongFollow, scope: "song" },
  { name: "setSongFollow", contract: setSongFollow, scope: "song", body: { following: true } },
  { name: "getProjectFollow", contract: getProjectFollow, scope: "project" },
  {
    name: "setProjectFollow",
    contract: setProjectFollow,
    scope: "project",
    body: { following: true },
  },
  // Comment scope: each role acts on its own comment (resolve and delete before restore).
  {
    name: "setCommentReaction",
    contract: setCommentReaction,
    scope: "comment",
    body: { emoji: "👍", active: true },
  },
  { name: "updateComment", contract: updateComment, scope: "comment", body: { body: "Edited" } },
  { name: "resolveComment", contract: resolveComment, scope: "comment", body: { resolved: true } },
  { name: "deleteComment", contract: deleteComment, scope: "comment" },
  { name: "restoreComment", contract: restoreComment, scope: "comment" },
  // Documents (SPEC §10): each role acts on a song document it created.
  { name: "listSongDocuments", contract: listSongDocuments, scope: "song" },
  { name: "listProjectDocuments", contract: listProjectDocuments, scope: "project" },
  {
    name: "createSongTextDocument",
    contract: createSongTextDocument,
    scope: "song",
    body: { title: "Lyrics", kind: "markdown", text: "# Hi" },
  },
  {
    name: "createProjectTextDocument",
    contract: createProjectTextDocument,
    scope: "project",
    body: { title: "Rules", kind: "markdown", text: "# Rules" },
  },
  { name: "getDocument", contract: getDocument, scope: "document" },
  { name: "listDocumentVersions", contract: listDocumentVersions, scope: "document" },
  { name: "updateDocument", contract: updateDocument, scope: "document", body: { title: "T" } },
  {
    name: "saveDocumentText",
    contract: saveDocumentText,
    scope: "document",
    bodyFor: (f) => ({ text: "# Edited", baseVersionId: f.docV2 }),
  },
  {
    name: "setCurrentDocumentVersion",
    contract: setCurrentDocumentVersion,
    scope: "document",
    bodyFor: (f) => ({ versionId: f.docV1 }),
  },
  { name: "retryDocumentVersion", contract: retryDocumentVersion, scope: "documentVersion" },
  { name: "deleteDocumentVersion", contract: deleteDocumentVersion, scope: "documentVersion" },
  { name: "restoreDocumentVersion", contract: restoreDocumentVersion, scope: "documentVersion" },
  { name: "deleteDocument", contract: deleteDocument, scope: "document" },
  { name: "restoreDocument", contract: restoreDocument, scope: "document" },
  // Public links (SPEC §3.5): editors of the scope.
  { name: "listProjectLinks", contract: listProjectLinks, scope: "project" },
  {
    name: "createProjectLink",
    contract: createProjectLink,
    scope: "project",
    body: LINK_BODY("project"),
  },
  { name: "listSongLinks", contract: listSongLinks, scope: "song" },
  { name: "createSongLink", contract: createSongLink, scope: "song", body: LINK_BODY("song") },
  { name: "updateLink", contract: updateLink, scope: "link", body: { label: "Renamed" } },
  { name: "getLinkAnalytics", contract: getLinkAnalytics, scope: "link" },
  {
    name: "updateProjectLink",
    contract: updateLink,
    scope: "projectLink",
    body: { active: false },
  },
  { name: "revokeLink", contract: revokeLink, scope: "link" },
  { name: "deleteSong", contract: deleteSong, scope: "song" },
  { name: "deleteProject", contract: deleteProject, scope: "project" },
];

let t: TestApp;
let bystanderId: string;
const fixtures = new Map<ContentRole, Fixture>();

beforeAll(async () => {
  t = await createTestApp();
  const owner = await seedUser(t, "owner", "admin");
  bystanderId = (await seedUser(t, "bystander", "member")).id;
  // One project per role, so destructive endpoints do not interfere with each other.
  for (const role of CONTENT_ROLES) {
    const user = await seedUser(t, `m${role}`, "member");
    const project = createProjectRow(t.db, { name: `P ${role}`, createdBy: owner.id });
    const song = createSongRow(t.db, { projectId: project.id, title: "S", createdBy: owner.id });
    setProjectGrantRow(t.db, project.id, user.id, role, owner.id);
    const comment = createCommentRow(t.db, {
      songId: song.id,
      authorUserId: user.id,
      body: "Mine",
      startSec: 1,
      endSec: null,
      trackId: null,
      parentId: null,
      context: { trackVersions: {}, tempoRev: null },
    });
    const asset = () =>
      createAsset(t.db, {
        kind: "document",
        originalFilename: "doc.md",
        sizeBytes: 1,
        originalHash: "x",
        uploadedBy: user.id,
      }).id;
    const doc = createDocumentWithVersion(t.db, {
      projectId: project.id,
      songId: song.id,
      title: "Doc",
      kind: "markdown",
      assetId: asset(),
      createdBy: user.id,
    });
    const v2 = addDocumentVersion(t.db, {
      documentId: doc.document.id,
      assetId: asset(),
      uploadedBy: user.id,
      source: "upload",
    });
    const link = (songId: string | null) =>
      createLinkRow(t.db, t.config.appSecret, {
        scopeType: songId ? "song" : "project",
        projectId: project.id,
        songId,
        versionIds: [],
        content: "all-tracks",
        versions: "current-only",
        passwordHash: null,
        expiresAt: null,
        allowDownload: false,
        allowComments: false,
        showComments: false,
        label: "",
        createdBy: owner.id,
      }).row.id;
    fixtures.set(role, {
      linkId: link(song.id),
      projectLinkId: link(null),
      cookie: await loginAs(t, `m${role}`),
      projectId: project.id,
      songId: song.id,
      commentId: comment.id,
      documentId: doc.document.id,
      docV1: doc.version.id,
      docV2: v2.version.id,
    });
  }
});
afterAll(async () => {
  await t.close();
});

function expectedFor(role: ContentRole, e: Endpoint): "allowed" | "NOT_FOUND" | "FORBIDDEN" {
  if (role === "none") return "NOT_FOUND";
  const auth = e.contract.auth;
  if (!auth || !("capability" in auth)) throw new Error(`${e.name} is not scoped`);
  return hasCapability(role, auth.capability) ? "allowed" : "FORBIDDEN";
}

describe("content permission matrix (project role via grant)", () => {
  for (const role of CONTENT_ROLES) {
    for (const e of ENDPOINTS) {
      const want = expectedFor(role, e);
      it(`${role} → ${e.name} → ${want}`, async () => {
        const f = fixtures.get(role);
        if (!f) throw new Error("fixture missing");
        const id = {
          project: f.projectId,
          song: f.songId,
          comment: f.commentId,
          document: f.documentId,
          documentVersion: f.docV1,
          link: f.linkId,
          projectLink: f.projectLinkId,
        }[e.scope];
        const params: Record<string, string> = { id };
        if (e.contract.path.includes(":userId")) params.userId = bystanderId;
        const body = e.bodyFor ? e.bodyFor(f) : e.body;
        const res = await call(
          t,
          e.contract,
          { params, ...(body !== undefined && { body }) },
          f.cookie,
        );
        const code = res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "allowed";
        if (want === "allowed") {
          // Allowed requests may still fail for domain reasons (e.g. unknown transfer target).
          expect(
            ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED"].includes(code) &&
              e.name !== "transferProjectOwnership",
          ).toBe(false);
        } else {
          expect(code).toBe(want);
        }
      });
    }
  }
});

describe("download policy on project scope (review L8)", () => {
  it("applies the project's download policy", () => {
    const f = fixtures.get("contributor");
    if (!f) throw new Error("fixture missing");
    const user = findUserByLogin(t.db, "mcontributor");
    if (!user) throw new Error("user missing");
    updateProjectRow(t.db, f.projectId, { downloadPolicy: "contributors" });
    expect(checkScope(t.db, user, "project", f.projectId, "download")).toMatchObject({
      scope: "project",
    });
    updateProjectRow(t.db, f.projectId, { downloadPolicy: "editors" });
    expect(() => checkScope(t.db, user, "project", f.projectId, "download")).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    updateProjectRow(t.db, f.projectId, { downloadPolicy: "all" });
  });
});
