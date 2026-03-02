// OneBot v11 protocol types

// ── Message Segments ────────────────────────────────────────────────

export type TextSegment = { type: "text"; data: { text: string } };
export type AtSegment = { type: "at"; data: { qq: string } };
export type FaceSegment = { type: "face"; data: { id: string } };
export type ImageSegment = {
  type: "image";
  data: { file?: string; url?: string; type?: string };
};
export type ReplySegment = { type: "reply"; data: { id: string } };

export type MessageSegment =
  | TextSegment
  | AtSegment
  | FaceSegment
  | ImageSegment
  | ReplySegment
  | { type: string; data: Record<string, string> };

// ── Sender ──────────────────────────────────────────────────────────

export type OneBotSender = {
  user_id: number;
  nickname: string;
  card?: string;
  sex?: string;
  age?: number;
  area?: string;
  level?: string;
  role?: "owner" | "admin" | "member";
  title?: string;
};

// ── Events ──────────────────────────────────────────────────────────

export type OneBotMessageEvent = {
  post_type: "message";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: MessageSegment[];
  raw_message: string;
  font: number;
  sender: OneBotSender;
  time: number;
  self_id: number;
};

export type OneBotMetaEvent = {
  post_type: "meta_event";
  meta_event_type: "heartbeat" | "lifecycle";
  sub_type?: string;
  time: number;
  self_id: number;
  status?: Record<string, unknown>;
  interval?: number;
};

export type OneBotNoticeEvent = {
  post_type: "notice";
  notice_type: string;
  [key: string]: unknown;
};

export type OneBotEvent =
  | OneBotMessageEvent
  | OneBotMetaEvent
  | OneBotNoticeEvent;

// ── API ─────────────────────────────────────────────────────────────

export type OneBotApiRequest = {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
};

export type OneBotApiResponse = {
  status: string;
  retcode: number;
  data: unknown;
  echo?: string;
  message?: string;
  wording?: string;
};

// ── Message target ──────────────────────────────────────────────────

export type MessageTarget =
  | { type: "private"; userId: number }
  | { type: "group"; groupId: number };
