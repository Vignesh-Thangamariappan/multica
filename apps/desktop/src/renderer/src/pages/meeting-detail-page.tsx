import { useParams } from "react-router-dom";
import { MeetingDetailPage as SharedMeetingDetailPage } from "@multica/views/meetings";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  useDocumentTitle("Meeting");
  if (!id) return null;
  return <SharedMeetingDetailPage meetingId={id} />;
}
