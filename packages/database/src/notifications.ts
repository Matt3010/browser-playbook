import type { PrismaClient } from "@prisma/client";

export const NOTIFICATION_TYPES = [
  "workflow_completed",
  "workflow_failed",
  "schedule_started",
  "schedule_missed"
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
}

/**
 * Delivery channel for notifications. The MVP ships only the in-app provider;
 * external providers (email, chat, webhook) can be added later by implementing
 * this interface and registering it in the service.
 */
export interface NotificationProvider {
  readonly name: string;
  send(payload: NotificationPayload): Promise<void>;
}

/** Persists notifications so the frontend can display them in-app. */
export class InAppNotificationProvider implements NotificationProvider {
  readonly name = "in-app";

  constructor(private readonly prisma: PrismaClient) {}

  async send(payload: NotificationPayload): Promise<void> {
    await this.prisma.notification.create({
      data: {
        userId: payload.userId,
        type: payload.type,
        title: payload.title,
        message: payload.message
      }
    });
  }
}

export class NotificationService {
  private readonly providers: NotificationProvider[];

  constructor(prisma: PrismaClient, extraProviders: NotificationProvider[] = []) {
    this.providers = [new InAppNotificationProvider(prisma), ...extraProviders];
  }

  /**
   * Notifying must never break an execution, so provider failures are swallowed
   * after being surfaced to the caller-supplied error sink.
   */
  async notify(payload: NotificationPayload, onError?: (err: unknown) => void): Promise<void> {
    for (const provider of this.providers) {
      try {
        await provider.send(payload);
      } catch (err) {
        onError?.(err);
      }
    }
  }
}
