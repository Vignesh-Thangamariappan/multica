"use client";

import { use } from "react";
import { MeetingDetailPage } from "@multica/views/meetings";

export default function MeetingDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <MeetingDetailPage meetingId={id} />;
}
