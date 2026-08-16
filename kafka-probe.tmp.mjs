import { Kafka } from 'kafkajs';

const kafka = new Kafka({ clientId: 'probe', brokers: ['localhost:9093'] });
const admin = kafka.admin();
await admin.connect();
const topics = await admin.listTopics();
console.log('CONNECTED. topics:', topics);
await admin.createTopics({ topics: [{ topic: 'probe.topic.v1' }] });
const producer = kafka.producer();
await producer.connect();
await producer.send({ topic: 'probe.topic.v1', messages: [{ value: 'hello' }] });
await producer.disconnect();
console.log('PRODUCE OK');
await admin.disconnect();
