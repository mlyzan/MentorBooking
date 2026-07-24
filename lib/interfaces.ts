export interface Mentor {
  id: string;
  name: string;
  email: string;
  expertises: string[];
}

export interface Student {
  id: string;
  name: string;
  email: string;
}

export interface GetMentorsEvent {
  expertises?: string;
}

export interface TimeSlot {
  id: string;
  mentorId: string;
  startTime: string;
  endTime: string;
  available: boolean;
}

export interface GetTimeSlotsEvent {
  mentorId: string;
  startTime?: string;
}

export interface BookingCreatedEvent {
  eventType: 'booking.created';
  bookingId: string;
  timeSlotId: string;
  mentorId: string;
  studentId: string;
  startTime: string;
  endTime: string;
  createdAt: string;
}

export interface BookingCanceledEvent {
  eventType: 'booking.canceled';
  bookingId: string;
  timeSlotId: string;
  mentorId: string;
  studentId: string;
  startTime: string;
  endTime: string;
}

export interface BookTimeSlotEvent {
  body: { timeSlotId: string; mentorId: string; studentId: string; startTime: string; endTime: string };
}

export interface CancelBookingEvent {
  bookingId: string;
}

export interface CreateTimeSlotEvent { 
  mentorId: string; 
  body: { startTime: string; endTime: string } 
}

export enum Sessions {
  FUTURE = 'FUTURE',
  PAST = 'PAST',
}
export interface BookedSessionsEvent {
  mentorId: string;
  sessions: Sessions
}

export interface BookedSession {
  id: string;
  mentorId: string;
  studentId: string;
  startTime: string;
  endTime: string;
  createdAt: string;
  timeSlotId: string;
}
