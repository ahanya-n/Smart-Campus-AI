class ComplaintResponse {
  const ComplaintResponse({
    required this.id,
    required this.authorName,
    required this.message,
    required this.createdAt,
    this.resolutionNotes,
  });

  final String id;
  final String authorName;
  final String message;
  final String createdAt;
  final String? resolutionNotes;

  factory ComplaintResponse.fromJson(Map<String, dynamic> json) {
    return ComplaintResponse(
      id: (json['id'] ?? '').toString(),
      authorName: (json['author_name'] ?? 'Campus staff').toString(),
      message: (json['message'] ?? '').toString(),
      createdAt: (json['created_at'] ?? '').toString(),
      resolutionNotes: json['resolution_notes']?.toString(),
    );
  }
}

class CampusComplaint {
  const CampusComplaint({
    required this.id,
    required this.category,
    required this.title,
    required this.description,
    required this.status,
    required this.createdAt,
    required this.responses,
    this.assignedStaffName,
    this.resolutionNotes,
  });

  final String id;
  final String category;
  final String title;
  final String description;
  final String status;
  final String createdAt;
  final String? assignedStaffName;
  final String? resolutionNotes;
  final List<ComplaintResponse> responses;

  factory CampusComplaint.fromJson(Map<String, dynamic> json) {
    return CampusComplaint(
      id: (json['id'] ?? '').toString(),
      category: (json['category'] ?? '').toString(),
      title: (json['title'] ?? '').toString(),
      description: (json['description'] ?? '').toString(),
      status: (json['status'] ?? 'pending').toString(),
      createdAt: (json['created_at'] ?? '').toString(),
      assignedStaffName: json['assigned_staff_name']?.toString(),
      resolutionNotes: json['resolution_notes']?.toString(),
      responses: (json['responses'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(ComplaintResponse.fromJson)
          .toList(),
    );
  }

  String get statusLabel => switch (status) {
        'in_progress' => 'In Progress',
        'resolved' => 'Resolved',
        'rejected' => 'Rejected',
        _ => 'Pending',
      };

  String get categoryLabel => switch (category) {
        'academic' => 'Academic',
        'facilities' => 'Facilities',
        'transport' => 'Transport',
        'library' => 'Library',
        'safety' => 'Safety',
        _ => 'Other',
      };
}
