export const MentorsTableName = 'MentorsTable';
export const StudentsTableName = 'StudentsTable';
export const TimeSlotsTableName = 'TimeSlotsTable';
export const BookingsTableName = 'BookingsTable';
export const BookingNotificationsQueueUrlEnv = 'BOOKING_NOTIFICATIONS_QUEUE_URL';
export const BookingNotificationsTopicArnEnv = 'BOOKING_NOTIFICATIONS_TOPIC_ARN';
export const MentorsTableNameEnv = 'MENTORS_TABLE_NAME';
export const StudentsTableNameEnv = 'STUDENTS_TABLE_NAME';
export const TimeSlotsTableNameEnv = 'TIME_SLOTS_TABLE_NAME';
export const BookingsTableNameEnv = 'BOOKINGS_TABLE_NAME';
export const ImportBucketName = 'import-mentors-bucket';
export const UploadedPrefix = 'mentors-import/';
export const ExportBookingsPrefix = 'booking-exports/';
export const ImportBucketNameEnv = 'IMPORT_BUCKET_NAME';
export const UploadedPrefixEnv = 'UPLOADED_PREFIX';
export const MentorsImportedQueueUrlEnv = 'MENTORS_IMPORTED_QUEUE_URL';
export const MentorsImportedTopicArnEnv = 'MENTORS_IMPORTED_TOPIC_ARN';
export const BookingsExportQueueUrlEnv = 'BOOKINGS_EXPORT_QUEUE_URL';
export const BookingsExportedQueueUrlEnv = 'BOOKINGS_EXPORTED_QUEUE_URL';
export const BookingsExportedTopicArnEnv = 'BOOKINGS_EXPORTED_TOPIC_ARN';
export const ExportUrlExpirationSecondsEnv = 'EXPORT_URL_EXPIRATION_SECONDS';
export const AdminEmailEnv = 'ADMIN_EMAIL';
export const UserPoolIdEnv = 'USER_POOL_ID';
export const UserPoolClientIdEnv = 'USER_POOL_CLIENT_ID';

export const StudentsGroup = 'Students';
export const MentorsGroup = 'Mentors';
export const AdminsGroup = 'Admins';

export const RouteAcl: Record<string, string[]> = {
  'GET /mentors':                        [StudentsGroup],
  'GET /mentors/{mentorId}/timeslots':   [StudentsGroup],
  'POST /bookings':                      [StudentsGroup],
  'DELETE /bookings/{bookingId}':        [StudentsGroup],
  'POST /mentors/{mentorId}/timeslots':  [MentorsGroup],
  'GET /mentors/{mentorId}/bookings':    [MentorsGroup],
  'POST /import/mentors':                [AdminsGroup],
  'POST /exports/bookings':              [AdminsGroup],
};
