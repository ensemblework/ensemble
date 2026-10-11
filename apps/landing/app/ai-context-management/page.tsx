import { TopicPage, topicMetadata } from "@/components/topic-page";
import { topicBySlug } from "@/lib/topics";

export const dynamic = "force-static";

const topic = topicBySlug("ai-context-management");

export const metadata = topicMetadata(topic);

export default function Page() {
  return <TopicPage topic={topic} />;
}
