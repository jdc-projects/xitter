import { Kafka } from 'kafkajs';
import { startKafka } from '@xitter/testing';
import { createEventConsumer, createEventProducer } from '@xitter/events';

const kafka = await startKafka();
const brokers = kafka.bootstrapServers.split(',');
const admin = new Kafka({ clientId: 'probe-admin', brokers }).admin();
await admin.connect();
await admin.createTopics({ topics: [{ topic: 'xitter.posts.v1' }] });
await admin.disconnect();

const producer = createEventProducer({ clientId: 'probe-producer', brokers });
await producer.emit('posts', {
  eventType: 'posts.post.created',
  producer: 'posts',
  occurredAt: new Date().toISOString(),
  key: 'probe-1',
  payload: { hello: 'world' },
});
console.log('emitted');

const consumer = createEventConsumer({
  clientId: 'probe-consumer',
  brokers,
  groupId: `probe-${crypto.randomUUID()}`,
  topics: ['posts'],
  fromBeginning: true,
});
await consumer.run(async (envelope) => {
  console.log('CONSUMED', JSON.stringify(envelope));
  await consumer.disconnect();
  await producer.disconnect();
  await kafka.stop();
  process.exit(0);
});
setTimeout(() => {
  console.log('TIMEOUT - nothing consumed in 30s');
  process.exit(1);
}, 30_000);
