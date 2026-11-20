class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.studentId,
    required this.subjectCode,
    required this.subjectName,
    required this.attendancePercentage,
    required this.threshold,
    required this.weekId,
    required this.warningType,
    required this.title,
    required this.message,
    required this.reportingDate,
    this.createdAt,
    required this.isRead,
  });

  final String id;
  final String studentId;
  final String subjectCode;
  final String subjectName;
  final double attendancePercentage;
  final double threshold;
  final String weekId;
  final String warningType;
  final String title;
  final String message;
  final String reportingDate;
  final String? createdAt;
  final bool isRead;

  factory NotificationItem.fromJson(Map<String, dynamic> json) {
    return NotificationItem(
      id: json['id']?.toString() ?? '',
      studentId: json['student_id']?.toString() ?? '',
      subjectCode: json['subject_code']?.toString() ?? '',
      subjectName: json['subject_name']?.toString() ?? '',
      attendancePercentage: (json['attendance_percentage'] as num?)?.toDouble() ?? 0.0,
      threshold: (json['threshold'] as num?)?.toDouble() ?? 75.0,
      weekId: json['week_id']?.toString() ?? '',
      warningType: json['warning_type']?.toString() ?? 'low_attendance',
      title: json['title']?.toString() ?? 'Attendance Alert',
      message: json['message']?.toString() ?? '',
      reportingDate: json['reporting_date']?.toString() ?? '',
      createdAt: json['created_at']?.toString(),
      isRead: json['is_read'] == true,
    );
  }
}
