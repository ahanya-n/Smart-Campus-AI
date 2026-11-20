class TransportDriver {
  const TransportDriver({required this.name, this.phone});

  final String name;
  final String? phone;

  factory TransportDriver.fromJson(Map<String, dynamic> json) {
    return TransportDriver(
      name: (json['name'] ?? '').toString(),
      phone: json['phone']?.toString(),
    );
  }
}

class TransportAssignment {
  const TransportAssignment({
    required this.studentId,
    required this.pickupPoint,
    required this.dropPoint,
    this.assignedAt,
  });

  final String studentId;
  final String pickupPoint;
  final String dropPoint;
  final DateTime? assignedAt;

  factory TransportAssignment.fromJson(Map<String, dynamic> json) {
    return TransportAssignment(
      studentId: (json['student_id'] ?? '').toString(),
      pickupPoint: (json['pickup_point'] ?? '').toString(),
      dropPoint: (json['drop_point'] ?? '').toString(),
      assignedAt: DateTime.tryParse((json['assigned_at'] ?? '').toString()),
    );
  }
}

class TransportRoute {
  const TransportRoute({
    required this.id,
    required this.routeNumber,
    required this.busNumber,
    required this.registrationNumber,
    required this.pickupPoints,
    required this.dropPoints,
    required this.driver,
    required this.capacity,
    required this.assignedSeats,
    required this.availableSeats,
    this.assignments = const [],
  });

  final String id;
  final String routeNumber;
  final String busNumber;
  final String registrationNumber;
  final List<String> pickupPoints;
  final List<String> dropPoints;
  final TransportDriver driver;
  final int capacity;
  final int assignedSeats;
  final int availableSeats;
  final List<TransportAssignment> assignments;

  factory TransportRoute.fromJson(Map<String, dynamic> json) {
    final assignments =
        (json['assignments'] as List?)
            ?.whereType<Map<String, dynamic>>()
            .map(TransportAssignment.fromJson)
            .toList() ??
        const <TransportAssignment>[];
    final capacity = int.tryParse((json['capacity'] ?? '0').toString()) ?? 0;
    final assigned =
        int.tryParse(
          (json['assigned_seats'] ?? assignments.length).toString(),
        ) ??
        assignments.length;
    return TransportRoute(
      id: (json['id'] ?? '').toString(),
      routeNumber: (json['route_number'] ?? '').toString(),
      busNumber: (json['bus_number'] ?? '').toString(),
      registrationNumber: (json['registration_number'] ?? '').toString(),
      pickupPoints:
          (json['pickup_points'] as List?)
              ?.map((value) => value.toString())
              .toList() ??
          const [],
      dropPoints:
          (json['drop_points'] as List?)
              ?.map((value) => value.toString())
              .toList() ??
          const [],
      driver: TransportDriver.fromJson(
        json['driver'] is Map<String, dynamic>
            ? json['driver'] as Map<String, dynamic>
            : const {},
      ),
      capacity: capacity,
      assignedSeats: assigned,
      availableSeats:
          int.tryParse(
            (json['available_seats'] ?? capacity - assigned).toString(),
          ) ??
          (capacity - assigned).clamp(0, capacity).toInt(),
      assignments: assignments,
    );
  }
}

class StudentTransportDetails {
  const StudentTransportDetails({
    required this.assigned,
    this.route,
    this.assignment,
  });

  final bool assigned;
  final TransportRoute? route;
  final TransportAssignment? assignment;

  factory StudentTransportDetails.fromJson(Map<String, dynamic> json) {
    final routeJson = json['route'];
    final assignmentJson = json['assignment'];
    return StudentTransportDetails(
      assigned: json['assigned'] == true,
      route: routeJson is Map<String, dynamic>
          ? TransportRoute.fromJson(routeJson)
          : null,
      assignment: assignmentJson is Map<String, dynamic>
          ? TransportAssignment.fromJson(assignmentJson)
          : null,
    );
  }
}

class TransportRouteDraft {
  const TransportRouteDraft({
    required this.routeNumber,
    required this.busNumber,
    required this.registrationNumber,
    required this.pickupPoints,
    required this.dropPoints,
    required this.driverName,
    required this.driverPhone,
    required this.capacity,
  });

  final String routeNumber;
  final String busNumber;
  final String registrationNumber;
  final List<String> pickupPoints;
  final List<String> dropPoints;
  final String driverName;
  final String driverPhone;
  final int capacity;

  Map<String, dynamic> toJson() => {
    'route_number': routeNumber,
    'bus_number': busNumber,
    'registration_number': registrationNumber,
    'pickup_points': pickupPoints,
    'drop_points': dropPoints,
    'driver': {'name': driverName, 'phone': driverPhone},
    'capacity': capacity,
  };
}
