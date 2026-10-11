import { TopicPage, topicMetadata } from "@/components/topic-page";
import { topicBySlug } from "@/lib/topics";

export const dynamic = "force-static";

const topic = topicBySlug("work-with-ai-agents");

export const metadata = topicMetadata(topic);

export default function Page() {
  return <TopicPage topic={topic} />;
}
