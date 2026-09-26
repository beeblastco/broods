/** Validates provider webhook JSON before channel adapters read or forward it. */

import { z } from "zod";
import type {
  TelegramMessage,
  TelegramRichBlock,
  TelegramRichText,
} from "@chat-adapter/telegram";

const githubUser = z.object({
  login: z.string().optional(),
  type: z.string().optional(),
});
const githubIssue = z.object({
  number: z.number().optional(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  user: githubUser.optional(),
  state: z.string().optional(),
  pull_request: z.object({}).optional(),
});
const pancakeSender = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  page_customer_id: z.string().optional(),
});
const zaloUpdate = z.object({
  event_name: z.string().optional(),
  message: z
    .object({
      message_id: z.string().optional(),
      from: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          display_name: z.string().optional(),
          is_bot: z.boolean().optional(),
        })
        .optional(),
      chat: z
        .object({ id: z.string().optional(), chat_type: z.string().optional() })
        .optional(),
      date: z.number().optional(),
      text: z.string().optional(),
      photo: z.string().optional(),
      caption: z.string().optional(),
      sticker: z.string().optional(),
      url: z.string().optional(),
      voice_url: z.string().optional(),
    })
    .optional(),
});
const telegramUser = z.object({
  id: z.number(),
  first_name: z.string(),
  is_bot: z.boolean(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});
const telegramChat = z.object({
  id: z.number(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  title: z.string().optional(),
  username: z.string().optional(),
});
const telegramEntity = z.object({
  type: z.string(),
  offset: z.number(),
  length: z.number(),
  language: z.string().optional(),
  url: z.string().optional(),
  user: telegramUser.optional(),
});
const telegramFile = z.object({
  file_id: z.string(),
  file_path: z.string().optional(),
  file_size: z.number().optional(),
  file_unique_id: z.string().optional(),
});
const telegramPhoto = telegramFile.extend({
  height: z.number(),
  width: z.number(),
});
const telegramAudio = telegramFile.extend({
  duration: z.number().optional(),
  performer: z.string().optional(),
  title: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
  thumbnail: telegramPhoto.optional(),
});
const telegramVideo = telegramFile.extend({
  duration: z.number(),
  width: z.number(),
  height: z.number(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
  thumbnail: telegramPhoto.optional(),
  cover: z.array(telegramPhoto).optional(),
  qualities: z
    .array(
      telegramFile.extend({
        codec: z.string(),
        height: z.number(),
        width: z.number(),
      }),
    )
    .optional(),
  start_timestamp: z.number().optional(),
});
const telegramVoice = telegramFile.extend({
  duration: z.number().optional(),
  mime_type: z.string().optional(),
});
const telegramRichText: z.ZodType<TelegramRichText> = z.lazy(
  (): z.ZodType<TelegramRichText> =>
    z.union([
      z.string(),
      z.array(telegramRichText),
      z.object({
        type: z.enum([
          "bold",
          "italic",
          "underline",
          "strikethrough",
          "spoiler",
          "subscript",
          "superscript",
          "marked",
          "code",
        ]),
        text: telegramRichText,
      }),
      z.object({
        type: z.literal("date_time"),
        text: telegramRichText,
        unix_time: z.number(),
        date_time_format: z.string(),
      }),
      z.object({
        type: z.literal("text_mention"),
        text: telegramRichText,
        user: telegramUser,
      }),
      z.object({
        type: z.literal("custom_emoji"),
        alternative_text: z.string(),
        custom_emoji_id: z.string(),
      }),
      z.object({
        type: z.literal("mathematical_expression"),
        expression: z.string(),
      }),
      z.object({
        type: z.literal("url"),
        text: telegramRichText,
        url: z.string(),
      }),
      z.object({
        type: z.literal("email_address"),
        text: telegramRichText,
        email_address: z.string(),
      }),
      z.object({
        type: z.literal("phone_number"),
        text: telegramRichText,
        phone_number: z.string(),
      }),
      z.object({
        type: z.literal("bank_card_number"),
        text: telegramRichText,
        bank_card_number: z.string(),
      }),
      z.object({
        type: z.literal("mention"),
        text: telegramRichText,
        username: z.string(),
      }),
      z.object({
        type: z.literal("hashtag"),
        text: telegramRichText,
        hashtag: z.string(),
      }),
      z.object({
        type: z.literal("cashtag"),
        text: telegramRichText,
        cashtag: z.string(),
      }),
      z.object({
        type: z.literal("bot_command"),
        text: telegramRichText,
        bot_command: z.string(),
      }),
      z.object({ type: z.literal("anchor"), name: z.string() }),
      z.object({
        type: z.literal("anchor_link"),
        text: telegramRichText,
        anchor_name: z.string(),
      }),
      z.object({
        type: z.literal("reference"),
        text: telegramRichText,
        name: z.string(),
      }),
      z.object({
        type: z.literal("reference_link"),
        text: telegramRichText,
        reference_name: z.string(),
      }),
    ]),
);
const telegramRichCaption = z.object({
  text: telegramRichText,
  credit: telegramRichText.optional(),
});
const telegramRichBlock: z.ZodType<TelegramRichBlock> = z.lazy(
  (): z.ZodType<TelegramRichBlock> =>
    z.union([
      z.object({
        type: z.enum(["paragraph", "footer", "thinking"]),
        text: telegramRichText,
      }),
      z.object({
        type: z.literal("heading"),
        text: telegramRichText,
        size: z.number(),
      }),
      z.object({
        type: z.literal("pre"),
        text: telegramRichText,
        language: z.string().optional(),
      }),
      z.object({ type: z.literal("divider") }),
      z.object({
        type: z.literal("mathematical_expression"),
        expression: z.string(),
      }),
      z.object({ type: z.literal("anchor"), name: z.string() }),
      z.object({
        type: z.literal("list"),
        items: z.array(
          z.object({
            blocks: z.array(telegramRichBlock),
            has_checkbox: z.literal(true).optional(),
            is_checked: z.literal(true).optional(),
            label: z.string(),
            type: z.enum(["a", "A", "i", "I", "1"]).optional(),
            value: z.number().optional(),
          }),
        ),
      }),
      z.object({
        type: z.literal("blockquote"),
        blocks: z.array(telegramRichBlock),
        credit: telegramRichText.optional(),
      }),
      z.object({
        type: z.literal("pullquote"),
        text: telegramRichText,
        credit: telegramRichText.optional(),
      }),
      z.object({
        type: z.enum(["collage", "slideshow"]),
        blocks: z.array(telegramRichBlock),
        caption: telegramRichCaption.optional(),
      }),
      z.object({
        type: z.literal("table"),
        caption: telegramRichText.optional(),
        cells: z.array(
          z.array(
            z.object({
              align: z.enum(["left", "center", "right"]),
              valign: z.enum(["top", "middle", "bottom"]),
              colspan: z.number().optional(),
              rowspan: z.number().optional(),
              is_header: z.literal(true).optional(),
              text: telegramRichText.optional(),
            }),
          ),
        ),
        is_bordered: z.literal(true).optional(),
        is_striped: z.literal(true).optional(),
      }),
      z.object({
        type: z.literal("details"),
        blocks: z.array(telegramRichBlock),
        is_open: z.literal(true).optional(),
        summary: telegramRichText,
      }),
      z.object({
        type: z.literal("map"),
        caption: telegramRichCaption.optional(),
        height: z.number(),
        width: z.number(),
        zoom: z.number(),
        location: z.object({
          latitude: z.number(),
          longitude: z.number(),
          heading: z.number().optional(),
          horizontal_accuracy: z.number().optional(),
          live_period: z.number().optional(),
          proximity_alert_radius: z.number().optional(),
        }),
      }),
      z.object({
        type: z.literal("animation"),
        animation: telegramVideo.omit({
          cover: true,
          qualities: true,
          start_timestamp: true,
        }),
        caption: telegramRichCaption.optional(),
        has_spoiler: z.literal(true).optional(),
      }),
      z.object({
        type: z.literal("audio"),
        audio: telegramAudio.extend({ duration: z.number() }),
        caption: telegramRichCaption.optional(),
      }),
      z.object({
        type: z.literal("photo"),
        photo: z.array(telegramPhoto),
        caption: telegramRichCaption.optional(),
        has_spoiler: z.literal(true).optional(),
      }),
      z.object({
        type: z.literal("video"),
        video: telegramVideo,
        caption: telegramRichCaption.optional(),
        has_spoiler: z.literal(true).optional(),
      }),
      z.object({
        type: z.literal("voice_note"),
        voice_note: telegramVoice.extend({ duration: z.number() }),
        caption: telegramRichCaption.optional(),
      }),
    ]),
);
const telegramMessage: z.ZodType<TelegramMessage> = z.lazy(
  (): z.ZodType<TelegramMessage> =>
    z.object({
      chat: telegramChat,
      message_id: z.number(),
      date: z.number(),
      from: telegramUser.optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
      entities: z.array(telegramEntity).optional(),
      caption_entities: z.array(telegramEntity).optional(),
      message_thread_id: z.number().optional(),
      media_group_id: z.string().optional(),
      edit_date: z.number().optional(),
      audio: telegramAudio.optional(),
      document: telegramFile
        .extend({
          file_name: z.string().optional(),
          mime_type: z.string().optional(),
        })
        .optional(),
      photo: z.array(telegramPhoto).optional(),
      sticker: telegramFile
        .extend({
          emoji: z.string().optional(),
          is_animated: z.boolean().optional(),
          is_video: z.boolean().optional(),
        })
        .optional(),
      video: telegramVideo.optional(),
      video_note: telegramFile
        .extend({
          length: z.number().optional(),
          duration: z.number().optional(),
        })
        .optional(),
      voice: telegramVoice.optional(),
      sender_chat: telegramChat.optional(),
      reply_to_message: telegramMessage.optional(),
      rich_message: z
        .object({
          blocks: z.array(telegramRichBlock),
          is_rtl: z.boolean().optional(),
        })
        .optional(),
    }),
);

export const githubWebhook = z.object({
  action: z.string().optional(),
  repository: z
    .object({
      full_name: z.string().optional(),
      name: z.string().optional(),
      owner: githubUser.optional(),
    })
    .optional(),
  issue: githubIssue.optional(),
  pull_request: githubIssue.optional(),
  comment: z
    .object({
      id: z.number().optional(),
      in_reply_to_id: z.number().optional(),
      body: z.string().nullable().optional(),
      created_at: z.string().optional(),
      path: z.string().optional(),
      line: z.number().nullable().optional(),
      original_line: z.number().nullable().optional(),
      user: githubUser.optional(),
    })
    .optional(),
  assignee: githubUser.optional(),
  installation: z.object({ id: z.number().optional() }).optional(),
  sender: githubUser.optional(),
});
export const matrixWebhook = z.object({
  type: z.literal("MATRIX_ROOM_EVENT"),
  encrypted: z.boolean(),
  roomId: z.string(),
  userId: z.string(),
  senderName: z.string().optional(),
  event: z.object({
    type: z.literal("m.room.message"),
    event_id: z.string(),
    origin_server_ts: z.number(),
    sender: z.string(),
    content: z.object({
      body: z.string().optional(),
      filename: z.string().optional(),
      msgtype: z.string().optional(),
      url: z.string().optional(),
      "app.broods.bot": z.boolean().optional(),
      "m.mentions": z
        .object({ user_ids: z.array(z.string()).optional() })
        .optional(),
      "m.relates_to": z
        .object({
          rel_type: z.string().optional(),
          event_id: z.string().optional(),
          "m.in_reply_to": z
            .object({ event_id: z.string().optional() })
            .optional(),
        })
        .optional(),
      file: z
        .object({
          url: z.string().optional(),
          iv: z.string().optional(),
          key: z.object({ k: z.string().optional() }).optional(),
          hashes: z.object({ sha256: z.string().optional() }).optional(),
        })
        .optional(),
      info: z
        .object({
          mimetype: z.string().optional(),
          size: z.number().optional(),
        })
        .optional(),
    }),
  }),
});
export const pancakeWebhook = z.object({
  page_id: z.string().optional(),
  event_type: z.string().optional(),
  data: z
    .object({
      conversation: z
        .object({
          id: z.string().optional(),
          type: z.string().optional(),
          tags: z.array(z.unknown()).optional(),
          from: pancakeSender.optional(),
        })
        .optional(),
      message: z
        .object({
          id: z.string().optional(),
          conversation_id: z.string().optional(),
          page_id: z.string().optional(),
          message: z.string().optional(),
          original_message: z.string().optional(),
          type: z.string().optional(),
          inserted_at: z.string().optional(),
          from: pancakeSender.optional(),
          is_hidden: z.boolean().optional(),
          is_removed: z.boolean().optional(),
          attachments: z
            .array(
              z.object({
                id: z.string().optional(),
                type: z.string().optional(),
                url: z.string().optional(),
                title: z.string().optional(),
                mime_type: z.string().optional(),
                video_data: z.object({ url: z.string().optional() }).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
      post: z.object({ id: z.string().optional() }).nullable().optional(),
    })
    .optional(),
});
export const telegramWebhook = z.object({
  update_id: z.number(),
  message: telegramMessage.optional(),
  edited_message: telegramMessage.optional(),
  callback_query: z
    .object({
      id: z.string(),
      chat_instance: z.string(),
      from: telegramUser,
      data: z.string().optional(),
      inline_message_id: z.string().optional(),
      message: telegramMessage.optional(),
    })
    .optional(),
});
export const zaloWebhook = zaloUpdate
  .extend({
    ok: z.boolean().optional(),
    result: zaloUpdate.optional(),
  })
  .transform((envelope): z.infer<typeof zaloUpdate> =>
    envelope.ok === true && envelope.result ? envelope.result : envelope,
  );

/** Invalid JSON or provider fields never reach adapter logic or appear in errors. */
export function parseChannelWebhook<T>(
  body: string,
  schema: z.ZodType<T>,
): T | null {
  try {
    const value: unknown = JSON.parse(body);
    const result = schema.safeParse(value);

    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
