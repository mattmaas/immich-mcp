/**
 * Immich MCP Server
 * 
 * Bidirectional MCP server for managing Immich photo library.
 * Can pull photos as images into LLM context and push metadata/descriptions back.
 * 
 * Environment Variables:
 * - IMMICH_URL: Your Immich instance URL (e.g., http://your-nas-ip:2283)
 * - IMMICH_API_KEY: Your Immich API key (User Settings > API Keys)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ============================================================================
// Configuration & Client
// ============================================================================

const IMMICH_URL = process.env.IMMICH_URL?.replace(/\/$/, "");
const IMMICH_API_KEY = process.env.IMMICH_API_KEY;

if (!IMMICH_URL || !IMMICH_API_KEY) {
  console.error("Missing required environment variables:");
  console.error("   IMMICH_URL - Your Immich instance URL (e.g., http://your-nas-ip:2283)");
  console.error("   IMMICH_API_KEY - Your Immich API key (User Settings > API Keys)");
  process.exit(1);
}

class ImmichClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Immich API error (${response.status}): ${errorText}`);
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}/api${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "x-api-key": this.apiKey,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Immich API error (${response.status}): ${errorText}`);
    }

    return response;
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "GET" });
  }

  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "DELETE",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async getImageAsBase64(endpoint: string): Promise<{ data: string; mimeType: string }> {
    const response = await this.requestRaw(endpoint, { method: "GET" });
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { data: base64, mimeType: contentType };
  }

  async uploadMultipart(endpoint: string, formData: FormData): Promise<unknown> {
    const url = `${this.baseUrl}/api${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
      },
      body: formData,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Immich API error (${response.status}): ${errorText}`);
    }
    return response.json();
  }
}

const client = new ImmichClient(IMMICH_URL, IMMICH_API_KEY);

// ============================================================================
// Helpers
// ============================================================================

function textResponse(payload: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
  };
}

function imageResponse(base64: string, mimeType: string, caption?: string) {
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
  if (caption) {
    content.push({ type: "text", text: caption });
  }
  content.push({ type: "image", data: base64, mimeType });
  return { content };
}

function formatAssetSummary(asset: any): string {
  const parts = [
    `ID: ${asset.id}`,
    `Type: ${asset.type}`,
    `File: ${asset.originalFileName}`,
  ];
  if (asset.exifInfo) {
    const e = asset.exifInfo;
    if (e.dateTimeOriginal) parts.push(`Date: ${e.dateTimeOriginal}`);
    if (e.city || e.state || e.country) parts.push(`Location: ${[e.city, e.state, e.country].filter(Boolean).join(", ")}`);
    if (e.make && e.model) parts.push(`Camera: ${e.make} ${e.model}`);
    if (e.imageName) parts.push(`Description: ${e.imageName}`);
  }
  if (asset.people && asset.people.length > 0) {
    parts.push(`People: ${asset.people.map((p: any) => p.name || "Unknown").join(", ")}`);
  }
  if (asset.isFavorite) parts.push("Favorite: Yes");
  return parts.join("\n");
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS = [
  // --- Search ---
  {
    name: "immich_search_smart",
    description: "Search photos using natural language (CLIP). Examples: 'sunset at beach', 'birthday cake', 'red car'. Returns matching photos with metadata. Use withImages=true to see thumbnails.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query" },
        size: { type: "number", description: "Number of results (default 10, max 100)" },
        withImages: { type: "boolean", description: "Include thumbnail images in response (default false)" },
        personIds: { type: "array", items: { type: "string" }, description: "Filter by person IDs" },
      },
      required: ["query"],
    },
  },
  {
    name: "immich_search_metadata",
    description: "Search photos by metadata: date range, location, camera, file type, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        originalFileName: { type: "string", description: "Search by filename" },
        city: { type: "string", description: "Filter by city" },
        state: { type: "string", description: "Filter by state" },
        country: { type: "string", description: "Filter by country" },
        make: { type: "string", description: "Camera make (e.g., Samsung, Apple)" },
        model: { type: "string", description: "Camera model" },
        takenAfter: { type: "string", description: "Photos taken after (ISO date)" },
        takenBefore: { type: "string", description: "Photos taken before (ISO date)" },
        type: { type: "string", enum: ["IMAGE", "VIDEO"], description: "Asset type" },
        isFavorite: { type: "boolean", description: "Filter favorites only" },
        size: { type: "number", description: "Number of results (default 20)" },
        withImages: { type: "boolean", description: "Include thumbnail images in response" },
      },
    },
  },
  {
    name: "immich_search_people",
    description: "Search for recognized people by name. Returns person entries with face thumbnails.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Person name to search for" },
        withHidden: { type: "boolean", description: "Include hidden people (default false)" },
      },
      required: ["name"],
    },
  },

  // --- Asset Operations ---
  {
    name: "immich_get_asset",
    description: "Fetch a photo/video and return it as an image the LLM can see. Use this to visually inspect a photo.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Asset ID" },
        size: { type: "string", enum: ["preview", "thumbnail"], description: "Image size (default: preview)" },
      },
      required: ["id"],
    },
  },
  {
    name: "immich_get_asset_info",
    description: "Get full metadata/EXIF info for an asset as JSON. Does not include the image itself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Asset ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "immich_upload_asset",
    description: "Upload an image to Immich. Provide base64 data or a description to generate. The image is added to the library.",
    inputSchema: {
      type: "object" as const,
      properties: {
        base64Data: { type: "string", description: "Image data as base64 string" },
        fileName: { type: "string", description: "Filename (e.g., photo.jpg)" },
        mimeType: { type: "string", description: "MIME type (default: image/jpeg)" },
      },
      required: ["base64Data", "fileName"],
    },
  },
  {
    name: "immich_update_asset",
    description: "Update an asset's metadata: description, favorite status, rating, date, location.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Asset ID" },
        description: { type: "string", description: "New description" },
        isFavorite: { type: "boolean", description: "Set favorite status" },
        rating: { type: "number", description: "Rating 0-5" },
        dateTimeOriginal: { type: "string", description: "Override original date (ISO format)" },
        latitude: { type: "number", description: "Override GPS latitude" },
        longitude: { type: "number", description: "Override GPS longitude" },
      },
      required: ["id"],
    },
  },
  {
    name: "immich_delete_assets",
    description: "Delete assets by IDs. Moves to trash by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Array of asset IDs to delete" },
        force: { type: "boolean", description: "Permanently delete (skip trash)" },
      },
      required: ["ids"],
    },
  },

  // --- Albums ---
  {
    name: "immich_list_albums",
    description: "List all albums with asset counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        shared: { type: "boolean", description: "Filter shared albums only" },
      },
    },
  },
  {
    name: "immich_create_album",
    description: "Create a new album, optionally adding assets to it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        albumName: { type: "string", description: "Album name" },
        description: { type: "string", description: "Album description" },
        assetIds: { type: "array", items: { type: "string" }, description: "Asset IDs to add" },
      },
      required: ["albumName"],
    },
  },
  {
    name: "immich_add_to_album",
    description: "Add assets to an existing album.",
    inputSchema: {
      type: "object" as const,
      properties: {
        albumId: { type: "string", description: "Album ID" },
        assetIds: { type: "array", items: { type: "string" }, description: "Asset IDs to add" },
      },
      required: ["albumId", "assetIds"],
    },
  },
  {
    name: "immich_get_album",
    description: "Get album details including all assets. Use withImages=true to see thumbnails of album contents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Album ID" },
        withImages: { type: "boolean", description: "Include thumbnail images of first 10 assets" },
      },
      required: ["id"],
    },
  },

  // --- People & Faces ---
  {
    name: "immich_list_people",
    description: "List all recognized people with face counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        withHidden: { type: "boolean", description: "Include hidden people" },
      },
    },
  },
  {
    name: "immich_rename_person",
    description: "Name or rename a recognized person.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Person ID" },
        name: { type: "string", description: "Person's name" },
        birthDate: { type: "string", description: "Birth date (YYYY-MM-DD)" },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "immich_merge_people",
    description: "Merge duplicate face clusters into one person.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Primary person ID (keep this one)" },
        mergeIds: { type: "array", items: { type: "string" }, description: "Person IDs to merge into the primary" },
      },
      required: ["id", "mergeIds"],
    },
  },

  // --- Library & Jobs ---
  {
    name: "immich_get_statistics",
    description: "Get library statistics: photo count, video count, total size, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "immich_run_job",
    description: "Trigger a server job: face detection, facial recognition, smart search (CLIP), sidecar metadata, thumbnail generation, video conversion, or storage migration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        jobName: {
          type: "string",
          enum: ["thumbnailGeneration", "metadataExtraction", "videoConversion", "faceDetection", "facialRecognition", "smartSearch", "storageTemplateMigration", "sidecar"],
          description: "Job to run",
        },
        force: { type: "boolean", description: "Force re-run even if already processed" },
      },
      required: ["jobName"],
    },
  },

  // --- Bidirectional: Describe & Tag ---
  {
    name: "immich_describe_photo",
    description: "Fetch a photo so the LLM can see it, along with all metadata. Perfect for generating descriptions, analyzing content, or identifying what's in a photo.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Asset ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "immich_bulk_update",
    description: "Bulk update descriptions/metadata for multiple assets. Feed LLM-generated descriptions back into Immich. Pass an array of {id, description, isFavorite, rating}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Asset ID" },
              description: { type: "string", description: "New description" },
              isFavorite: { type: "boolean", description: "Set favorite" },
              rating: { type: "number", description: "Rating 0-5" },
            },
            required: ["id"],
          },
          description: "Array of updates to apply",
        },
      },
      required: ["updates"],
    },
  },

  // --- Server Info ---
  {
    name: "immich_server_info",
    description: "Get Immich server version, features, and configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // --- Random/Explore ---
  {
    name: "immich_random_assets",
    description: "Get random photos from the library. Great for exploring or sampling. Use withImages=true to see them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        count: { type: "number", description: "Number of random assets (default 5, max 20)" },
        withImages: { type: "boolean", description: "Include thumbnail images" },
      },
    },
  },

  // --- Timeline ---
  {
    name: "immich_get_asset_by_date",
    description: "Get photos from a specific date or date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Date (YYYY-MM-DD)" },
        size: { type: "number", description: "Number of results (default 20)" },
        withImages: { type: "boolean", description: "Include thumbnail images" },
      },
      required: ["date"],
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleTool(name: string, args: Record<string, unknown>): Promise<any> {
  switch (name) {

    // ---- Search ----

    case "immich_search_smart": {
      const query = args.query as string;
      const size = Math.min((args.size as number) || 10, 100);
      const withImages = args.withImages as boolean || false;
      const body: any = { query, size };
      if (args.personIds) body.personIds = args.personIds;

      const result: any = await client.post("/search/smart", body);
      const assets = result.assets?.items || result.assets || [];

      if (!withImages) {
        return textResponse({
          query,
          totalResults: assets.length,
          assets: assets.map((a: any) => ({
            id: a.id,
            type: a.type,
            fileName: a.originalFileName,
            date: a.exifInfo?.dateTimeOriginal,
            location: [a.exifInfo?.city, a.exifInfo?.state, a.exifInfo?.country].filter(Boolean).join(", ") || null,
            people: a.people?.map((p: any) => p.name).filter(Boolean) || [],
            isFavorite: a.isFavorite,
          })),
        });
      }

      // Return with thumbnails
      const content: any[] = [{ type: "text", text: `Smart search: "${query}" — ${assets.length} results` }];
      const maxImages = Math.min(assets.length, 10);
      for (let i = 0; i < maxImages; i++) {
        try {
          const img = await client.getImageAsBase64(`/assets/${assets[i].id}/thumbnail`);
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} (${assets[i].id}) ---` });
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        } catch {
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} (${assets[i].id}) — thumbnail unavailable ---` });
        }
      }
      return { content };
    }

    case "immich_search_metadata": {
      const withImages = args.withImages as boolean || false;
      delete (args as any).withImages;
      const size = (args.size as number) || 20;
      delete (args as any).size;

      const body: any = { ...args, size };
      const result: any = await client.post("/search/metadata", body);
      const assets = result.assets?.items || result.assets || [];

      if (!withImages) {
        return textResponse({
          totalResults: assets.length,
          assets: assets.map((a: any) => ({
            id: a.id,
            type: a.type,
            fileName: a.originalFileName,
            date: a.exifInfo?.dateTimeOriginal,
            location: [a.exifInfo?.city, a.exifInfo?.state, a.exifInfo?.country].filter(Boolean).join(", ") || null,
            camera: a.exifInfo?.make && a.exifInfo?.model ? `${a.exifInfo.make} ${a.exifInfo.model}` : null,
            isFavorite: a.isFavorite,
          })),
        });
      }

      const content: any[] = [{ type: "text", text: `Metadata search — ${assets.length} results` }];
      const maxImages = Math.min(assets.length, 10);
      for (let i = 0; i < maxImages; i++) {
        try {
          const img = await client.getImageAsBase64(`/assets/${assets[i].id}/thumbnail`);
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} (${assets[i].id}) ---` });
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        } catch {
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} (${assets[i].id}) — thumbnail unavailable ---` });
        }
      }
      return { content };
    }

    case "immich_search_people": {
      const name = args.name as string;
      const withHidden = args.withHidden as boolean || false;
      const result: any = await client.get(`/search/person?name=${encodeURIComponent(name)}&withHidden=${withHidden}`);
      const people = Array.isArray(result) ? result : result.people || [];
      return textResponse({
        query: name,
        results: people.map((p: any) => ({
          id: p.id,
          name: p.name,
          birthDate: p.birthDate,
          thumbnailPath: p.thumbnailPath,
          isHidden: p.isHidden,
        })),
      });
    }

    // ---- Asset Operations ----

    case "immich_get_asset": {
      const id = args.id as string;
      const size = (args.size as string) || "preview";
      const img = await client.getImageAsBase64(`/assets/${id}/${size}`);
      const info: any = await client.get(`/assets/${id}`);
      return imageResponse(img.data, img.mimeType, formatAssetSummary(info));
    }

    case "immich_get_asset_info": {
      const id = args.id as string;
      const info: any = await client.get(`/assets/${id}`);
      return textResponse({
        id: info.id,
        type: info.type,
        fileName: info.originalFileName,
        originalPath: info.originalPath,
        isFavorite: info.isFavorite,
        isArchived: info.isArchived,
        duration: info.duration,
        exif: info.exifInfo,
        people: info.people?.map((p: any) => ({ id: p.id, name: p.name })) || [],
        tags: info.tags || [],
        smartInfo: info.smartInfo,
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
      });
    }

    case "immich_upload_asset": {
      const base64Data = args.base64Data as string;
      const fileName = args.fileName as string;
      const mimeType = (args.mimeType as string) || "image/jpeg";

      const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");
      const blob = new Blob([buffer], { type: mimeType });

      const formData = new FormData();
      formData.append("assetData", blob, fileName);
      formData.append("deviceAssetId", `mcp-upload-${Date.now()}`);
      formData.append("deviceId", "mcp-immich-server");
      formData.append("fileCreatedAt", new Date().toISOString());
      formData.append("fileModifiedAt", new Date().toISOString());

      const result = await client.uploadMultipart("/assets", formData);
      return textResponse({ success: true, message: `Uploaded ${fileName}`, result });
    }

    case "immich_update_asset": {
      const id = args.id as string;
      const body: any = {};
      if (args.description !== undefined) body.description = args.description;
      if (args.isFavorite !== undefined) body.isFavorite = args.isFavorite;
      if (args.rating !== undefined) body.rating = args.rating;
      if (args.dateTimeOriginal !== undefined) body.dateTimeOriginal = args.dateTimeOriginal;
      if (args.latitude !== undefined) body.latitude = args.latitude;
      if (args.longitude !== undefined) body.longitude = args.longitude;

      const result = await client.put(`/assets/${id}`, body);
      return textResponse({ success: true, id, updated: Object.keys(body), result });
    }

    case "immich_delete_assets": {
      const ids = args.ids as string[];
      const force = args.force as boolean || false;
      const result = await client.delete("/assets", { ids, force });
      return textResponse({ success: true, deleted: ids.length, force, result });
    }

    // ---- Albums ----

    case "immich_list_albums": {
      const shared = args.shared as boolean | undefined;
      let endpoint = "/albums";
      if (shared !== undefined) endpoint += `?shared=${shared}`;
      const albums: any[] = await client.get(endpoint);
      return textResponse({
        totalAlbums: albums.length,
        albums: albums.map((a: any) => ({
          id: a.id,
          albumName: a.albumName,
          description: a.description,
          assetCount: a.assetCount,
          createdAt: a.createdAt,
          shared: a.shared,
        })),
      });
    }

    case "immich_create_album": {
      const body: any = { albumName: args.albumName };
      if (args.description) body.description = args.description;
      if (args.assetIds) body.assetIds = args.assetIds;
      const result = await client.post("/albums", body);
      return textResponse({ success: true, message: `Created album "${args.albumName}"`, result });
    }

    case "immich_add_to_album": {
      const albumId = args.albumId as string;
      const assetIds = args.assetIds as string[];
      const result = await client.put(`/albums/${albumId}/assets`, { ids: assetIds });
      return textResponse({ success: true, albumId, addedAssets: assetIds.length, result });
    }

    case "immich_get_album": {
      const id = args.id as string;
      const withImages = args.withImages as boolean || false;
      const album: any = await client.get(`/albums/${id}`);

      if (!withImages) {
        return textResponse({
          id: album.id,
          albumName: album.albumName,
          description: album.description,
          assetCount: album.assetCount,
          createdAt: album.createdAt,
          assets: (album.assets || []).slice(0, 50).map((a: any) => ({
            id: a.id,
            fileName: a.originalFileName,
            type: a.type,
            date: a.exifInfo?.dateTimeOriginal,
          })),
        });
      }

      const content: any[] = [{ type: "text", text: `Album: "${album.albumName}" — ${album.assetCount} assets` }];
      const assets = album.assets || [];
      const maxImages = Math.min(assets.length, 10);
      for (let i = 0; i < maxImages; i++) {
        try {
          const img = await client.getImageAsBase64(`/assets/${assets[i].id}/thumbnail`);
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} ---` });
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        } catch {
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} — unavailable ---` });
        }
      }
      return { content };
    }

    // ---- People ----

    case "immich_list_people": {
      const withHidden = args.withHidden as boolean || false;
      const result: any = await client.get(`/people?withHidden=${withHidden}`);
      const people = result.people || (Array.isArray(result) ? result : []);
      return textResponse({
        totalPeople: people.length,
        people: people.map((p: any) => ({
          id: p.id,
          name: p.name || "(unnamed)",
          birthDate: p.birthDate,
          isHidden: p.isHidden,
          assetCount: p.assetCount,
        })),
      });
    }

    case "immich_rename_person": {
      const id = args.id as string;
      const body: any = { name: args.name };
      if (args.birthDate) body.birthDate = args.birthDate;
      const result = await client.put(`/people/${id}`, body);
      return textResponse({ success: true, id, name: args.name, result });
    }

    case "immich_merge_people": {
      const id = args.id as string;
      const mergeIds = args.mergeIds as string[];
      const result = await client.post(`/people/${id}/merge`, { ids: mergeIds });
      return textResponse({ success: true, primaryId: id, mergedIds: mergeIds, result });
    }

    // ---- Library & Jobs ----

    case "immich_get_statistics": {
      const stats = await client.get("/server/statistics");
      return textResponse(stats);
    }

    case "immich_run_job": {
      const jobName = args.jobName as string;
      const force = args.force as boolean || false;
      const result = await client.put(`/jobs/${jobName}`, { command: "start", force });
      return textResponse({ success: true, jobName, force, result });
    }

    // ---- Bidirectional: Describe & Bulk Update ----

    case "immich_describe_photo": {
      const id = args.id as string;
      const [info, img] = await Promise.all([
        client.get<any>(`/assets/${id}`),
        client.getImageAsBase64(`/assets/${id}/preview`),
      ]);

      const metadata = formatAssetSummary(info);
      const content: any[] = [
        { type: "text", text: `Photo metadata:\n${metadata}\n\nHere is the photo:` },
        { type: "image", data: img.data, mimeType: img.mimeType },
      ];
      return { content };
    }

    case "immich_bulk_update": {
      const updates = args.updates as Array<{ id: string; description?: string; isFavorite?: boolean; rating?: number }>;
      const results: any[] = [];
      for (const update of updates) {
        const { id, ...body } = update;
        try {
          await client.put(`/assets/${id}`, body);
          results.push({ id, success: true, updated: Object.keys(body) });
        } catch (err: any) {
          results.push({ id, success: false, error: err.message });
        }
      }
      const successCount = results.filter(r => r.success).length;
      return textResponse({
        totalUpdates: updates.length,
        successful: successCount,
        failed: updates.length - successCount,
        results,
      });
    }

    // ---- Server Info ----

    case "immich_server_info": {
      const [version, config, about] = await Promise.all([
        client.get("/server/version").catch(() => null),
        client.get("/server/config").catch(() => null),
        client.get("/server/about").catch(() => null),
      ]);
      return textResponse({ version, config, about });
    }

    // ---- Random ----

    case "immich_random_assets": {
      const count = Math.min((args.count as number) || 5, 20);
      const withImages = args.withImages as boolean || false;
      const assets: any[] = await client.get(`/assets/random?count=${count}`);

      if (!withImages) {
        return textResponse({
          count: assets.length,
          assets: assets.map((a: any) => ({
            id: a.id,
            type: a.type,
            fileName: a.originalFileName,
            date: a.exifInfo?.dateTimeOriginal,
            location: [a.exifInfo?.city, a.exifInfo?.state, a.exifInfo?.country].filter(Boolean).join(", ") || null,
          })),
        });
      }

      const content: any[] = [{ type: "text", text: `${assets.length} random photos:` }];
      for (let i = 0; i < assets.length; i++) {
        try {
          const img = await client.getImageAsBase64(`/assets/${assets[i].id}/thumbnail`);
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} (${assets[i].id}) ---` });
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        } catch {
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} — unavailable ---` });
        }
      }
      return { content };
    }

    // ---- Timeline / Date ----

    case "immich_get_asset_by_date": {
      const date = args.date as string;
      const size = (args.size as number) || 20;
      const withImages = args.withImages as boolean || false;

      // Use metadata search with date range
      const startOfDay = `${date}T00:00:00.000Z`;
      const endOfDay = `${date}T23:59:59.999Z`;
      const result: any = await client.post("/search/metadata", {
        takenAfter: startOfDay,
        takenBefore: endOfDay,
        size,
      });
      const assets = result.assets?.items || result.assets || [];

      if (!withImages) {
        return textResponse({
          date,
          totalResults: assets.length,
          assets: assets.map((a: any) => ({
            id: a.id,
            type: a.type,
            fileName: a.originalFileName,
            time: a.exifInfo?.dateTimeOriginal,
          })),
        });
      }

      const content: any[] = [{ type: "text", text: `Photos from ${date} — ${assets.length} results` }];
      const maxImages = Math.min(assets.length, 10);
      for (let i = 0; i < maxImages; i++) {
        try {
          const img = await client.getImageAsBase64(`/assets/${assets[i].id}/thumbnail`);
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} ---` });
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        } catch {
          content.push({ type: "text", text: `\n--- ${i + 1}. ${assets[i].originalFileName} — unavailable ---` });
        }
      }
      return { content };
    }

    default:
      return textResponse({ error: `Unknown tool: ${name}` }, true);
  }
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  { name: "mcp-immich", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  console.error(`[immich] Tool call: ${name}`);
  try {
    return await handleTool(name, args as Record<string, unknown>);
  } catch (err: any) {
    console.error(`[immich] Error in ${name}:`, err.message);
    return textResponse({ error: err.message, tool: name }, true);
  }
});

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[immich] MCP server connected — ${IMMICH_URL}`);

  const keepAlive = setInterval(() => {}, 60000);
  transport.onclose = () => {
    console.error("[immich] Transport closed");
    clearInterval(keepAlive);
    process.exit(0);
  };
}

main().catch((err) => {
  console.error("[immich] Fatal error:", err);
  process.exit(1);
});
