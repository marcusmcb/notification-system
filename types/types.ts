/* TYPE DEFINITIONS */

type StudentId = string

type Notification = {
  id: string // unique id for de-duplication
  studentId: StudentId
  message: string
  createdAt: number // epoch ms
}

type PublishBody = {
  studentId: StudentId
  message: string
}

type BatchPublishBody = {
  notifications: PublishBody[]
}

export { StudentId, Notification, PublishBody, BatchPublishBody } 